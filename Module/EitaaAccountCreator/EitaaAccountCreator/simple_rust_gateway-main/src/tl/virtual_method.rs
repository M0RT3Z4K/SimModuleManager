use serde_json::{json, Value};
use crate::service::GatewayService;

fn new_random_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap()
        .as_millis() as u64;
    let now_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap()
        .subsec_nanos() as u64;
    let id = ((now_ms << 17) ^ (now_ns.wrapping_mul(6364136223846793005)))
        & 0x7FFF_FFFF_FFFF_FFFF_u64;
    id.to_string()
}

fn normalize_file_reference(raw: &Value) -> Value {
    match raw {
        Value::Array(_) => raw.clone(),

        Value::Object(map) => {
            let mut pairs: Vec<(usize, u8)> = map
                .iter()
                .filter_map(|(k, v)| {
                    let idx = k.parse::<usize>().ok()?;
                    let byte = v.as_u64()? as u8;
                    Some((idx, byte))
                })
                .collect();

            pairs.sort_by_key(|(idx, _)| *idx);

            let bytes: Vec<Value> = pairs
                .into_iter()
                .map(|(_, byte)| Value::Number(byte.into()))
                .collect();

            Value::Array(bytes)
        }

        _ => Value::Array(vec![]),
    }
}

fn build_input_media(media: &Value) -> Option<Value> {
    let media_type = media["_"].as_str()?;

    match media_type {
        "messageMediaPhoto" => {
            let photo = &media["photo"];

            if photo["_"].as_str() == Some("photoEmpty") {
                return None;
            }

            let file_ref = normalize_file_reference(&photo["file_reference"]);

            Some(json!({
                "_":    "inputMediaPhoto",
                "flags": 0,
                "id": {
                    "_":             "inputPhoto",
                    "id":            photo["id"],
                    "access_hash":   photo["access_hash"],
                    "file_reference": file_ref
                }
            }))
        }

        "messageMediaDocument" => {
            let doc = &media["document"];

            if doc["_"].as_str() == Some("documentEmpty") {
                return None;
            }

            let file_ref = normalize_file_reference(&doc["file_reference"]);

            Some(json!({
                "_":    "inputMediaDocument",
                "flags": 0,
                "id": {
                    "_":             "inputDocument",
                    "id":            doc["id"],
                    "access_hash":   doc["access_hash"],
                    "file_reference": file_ref
                }
            }))
        }

        _ => None,
    }
}

pub fn copy_message<'a>(
    service:    &'a GatewayService,
    params:     &'a Value,
    token:      &'a str,
    imei:       &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + 'a>> {
    Box::pin(async move {
        let from_peer  = &params["from_peer"];
        let to_peer    = &params["to_peer"];
        let message_id = params["message_id"].as_i64().unwrap_or(0);
        let caption    = params["caption"].as_str().unwrap_or("");


        let history_resp = service.call(
            "messages.getHistory",
            json!({
                "peer":        from_peer,
                "offset_id":   message_id,
                "add_offset":  1,
                "limit":       1
            }),
            token,
            imei,
        ).await;

        if history_resp.status != "ok" {
            return json!({
                "_":    "error",
                "code": 500,
                "text": history_resp.message.unwrap_or_default()
            });
        }

        let history_data = match history_resp.data {
            Some(d) => d,
            None => return json!({"_":"error","code":500,"text":"getHistory returned no data"}),
        };

        let messages = match history_data["messages"].as_array() {
            Some(m) => m,
            None => return json!({"_":"error","code":500,"text":"no messages array"}),
        };

        if messages.is_empty() {
            return json!({"_":"error","code":404,"text":"message not found"});
        }

        let target_msg = &messages[0];


        let grouped_id = target_msg["grouped_id"]
            .as_str()
            .filter(|s| !s.is_empty());

        match grouped_id {
            Some(gid) => {
                copy_grouped(service, from_peer, to_peer, message_id, gid, caption, token, imei).await
            }

            None => {
                copy_single(service, target_msg, to_peer, caption, token, imei).await
            }
        }
    })
}

async fn copy_single(
    service:    &GatewayService,
    msg:        &Value,
    to_peer:    &Value,
    caption:    &str,
    token:      &str,
    imei:       &str,
) -> Value {
    let media = match msg.get("media") {
        Some(m) => m,
        None => return json!({"_":"error","code":400,"text":"message has no media field"}),
    };

    let input_media = match build_input_media(media) {
        Some(m) => m,
        None => return json!({
            "_":    "error",
            "code": 400,
            "text": format!("unsupported media type: {}", media["_"].as_str().unwrap_or("unknown"))
        }),
    };

    let send_resp = service.call(
        "messages.sendMedia",
        json!({
            "flags":     128,
            "peer":      to_peer,
            "media":     input_media,
            "message":   caption,
            "random_id": new_random_id()
        }),
        token,
        imei,
    ).await;

    match send_resp.data {
        Some(d) => d,
        None    => json!({
            "_":    "error",
            "code": 500,
            "text": send_resp.message.unwrap_or_default()
        }),
    }
}


async fn copy_grouped(
    service:    &GatewayService,
    from_peer:  &Value,
    to_peer:    &Value,
    message_id: i64,
    grouped_id: &str,
    caption:    &str,
    token:      &str,
    imei:       &str,
) -> Value {
    let window_resp = service.call(
        "messages.getHistory",
        json!({
            "peer":        from_peer,
            "offset_id":   message_id + 1,
            "offset_date": 0,
            "add_offset":  -10,   // 10 so target is near center
            "limit":       20,
            "max_id":      0,
            "min_id":      0,
            "hash":        0,
            "flags":       0
        }),
        token,
        imei,
    ).await;

    if window_resp.status != "ok" {
        return json!({
            "_":    "error",
            "code": 500,
            "text": format!("failed to fetch album window: {}",
                window_resp.message.unwrap_or_default())
        });
    }

    let window_data = match window_resp.data {
        Some(d) => d,
        None    => return json!({"_":"error","code":500,"text":"album fetch returned no data"}),
    };

    let all_messages = match window_data["messages"].as_array() {
        Some(m) => m,
        None    => return json!({"_":"error","code":500,"text":"no messages in album window"}),
    };

    let mut album: Vec<&Value> = all_messages
        .iter()
        .filter(|m| {
            m["grouped_id"].as_str()
                .filter(|gid| *gid == grouped_id)
                .is_some()
        })
        .collect();

    album.sort_by_key(|m| m["id"].as_i64().unwrap_or(0));

    if album.is_empty() {
        return json!({"_":"error","code":404,"text":"no album members found"});
    }

    let mut multi_media: Vec<Value> = Vec::new();

    for (index, msg) in album.iter().enumerate() {
        let media = match msg.get("media") {
            Some(m) => m,
            None    => continue,   // skip messages without media (shouldn't happen in albums)
        };

        let input_media = match build_input_media(media) {
            Some(m) => m,
            None    => continue,   // skip unsupported media types
        };

        let item_caption = if index == 0 { caption } else { "" };

        multi_media.push(json!({
            "_":         "inputSingleMedia",
            "flags":     0,
            "media":     input_media,
            "random_id": new_random_id(),
            "message":   item_caption
        }));
    }

    if multi_media.is_empty() {
        return json!({
            "_":    "error",
            "code": 400,
            "text": "album contained no supported media items"
        });
    }

    let send_resp = service.call(
        "messages.sendMultiMedia",
        json!({
            "flags": 0,
            "peer":  to_peer,
            "multi_media": multi_media
        }),
        token,
        imei,
    ).await;

    match send_resp.data {
        Some(d) => d,
        None    => json!({
            "_":    "error",
            "code": 500,
            "text": send_resp.message.unwrap_or_default()
        }),
    }
}


