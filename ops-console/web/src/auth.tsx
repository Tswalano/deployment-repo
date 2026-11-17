import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, Me, SiteConfig } from './api';

interface AuthState {
  user: Me | null;
  loading: boolean;
  /** Single-team console or the multi-customer product (and its name). */
  site: SiteConfig;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [site, setSite] = useState<SiteConfig>({ multiTenant: false, productName: 'Ops Console', trialDays: 14 });
  // wait for the mode too: deciding "signed out → landing page or sign-in?" before it arrives sent everyone to /login
  const [siteLoaded, setSiteLoaded] = useState(false);
  useEffect(() => { api.site().then(setSite).catch(() => undefined).finally(() => setSiteLoaded(true)); }, []);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <AuthContext.Provider value={{ user, loading: loading || !siteLoaded, site, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
