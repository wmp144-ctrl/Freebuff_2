import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import type { AuthUser } from './types';

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  /** ساخت نخستین مدیر در راه‌اندازی اولیه؛ پس از موفقیت، خودکار وارد می‌شود */
  setupAdmin: (username: string, password: string, confirmPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  /** بررسی مجوز سمت کلاینت برای پنهان‌کردن عملیات غیرمجاز (سرور همچنان مرجع است) */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  error: null,
  login: async () => {},
  setupAdmin: async () => {},
  logout: async () => {},
  can: () => false,
});

export const useAuth = () => useContext(AuthContext);

/**
 * نشست کاربر را از سرور می‌خواند. هر 401 از API (نشست منقضی) رویداد
 * nw:unauthorized را می‌فرستد و این‌جا کاربر پاک می‌شود تا صفحهٔ ورود بیاید.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const onUnauthorized = () => setUser(null);
    window.addEventListener('nw:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nw:unauthorized', onUnauthorized);
  }, [load]);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const res = await api.login(username, password);
      setUser(res.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'ورود ناموفق بود.');
      throw e;
    }
  }, []);

  const setupAdmin = useCallback(async (username: string, password: string, confirmPassword: string) => {
    setError(null);
    try {
      const res = await api.setupAdmin({ username, password, confirmPassword });
      setUser(res.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'ساخت حساب مدیر ناموفق بود.');
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const can = useCallback(
    (permission: string) => !!user?.permissions?.includes(permission),
    [user]
  );

  const value = useMemo(
    () => ({ user, loading, error, login, setupAdmin, logout, can }),
    [user, loading, error, login, setupAdmin, logout, can]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
