import axios from 'axios';

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api';
export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use(config => {
  const token = sessionStorage.getItem('simcard_api_token') || import.meta.env.VITE_API_TOKEN;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
