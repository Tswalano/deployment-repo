import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Account } from './pages/Account';
import { Activity } from './pages/Activity';
import { Alerts } from './pages/Alerts';
import { AppDetail } from './pages/AppDetail';
import { Audit } from './pages/Audit';
import { Costs } from './pages/Costs';
import { Backups } from './pages/Backups';
import { InstanceDetail } from './pages/InstanceDetail';
import { Instances } from './pages/Instances';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Settings } from './pages/Settings';
import { NewApp } from './pages/NewApp';
import { Access } from './pages/Access';
// the terminal (xterm.js) loads only when opened
const Terminal = lazy(() => import('./pages/Terminal').then((m) => ({ default: m.Terminal })));
import { GithubCallback } from './components/GithubConnect';
import { Users } from './pages/Users';
import { AcceptInvite, ForgotPassword, ResetPassword, Signup, VerifyEmail } from './pages/Public';
import { Landing } from './pages/Landing';
import { Docs } from './pages/Docs';
import { Privacy, Security, Terms } from './pages/Legal';
import { Team } from './pages/Team';
import { Billing, BillingReturn } from './pages/Billing';
import { useLocation } from 'react-router-dom';
import type { Role } from './api';
import './index.css';
import { Platform, PlatformAuditPage, PlatformConsolePage, PlatformWorkspacePage } from './pages/Platform';
import { DialogProvider } from './components/Dialog';

function Protected({ children, role }: { children: JSX.Element; role?: Role }) {
  const { user, loading, site } = useAuth();
  const { pathname, search } = useLocation();
  if (loading) return <div className="grid h-screen place-items-center text-sm text-slate-500">Loading…</div>;
  if (!user) {
    if (site.multiTenant && pathname === '/') return <Landing />;   // the product's public front page
    return <Navigate to={pathname === '/' ? '/login' : `/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  }
  if (role === 'admin' && user.role !== 'admin') return <Navigate to="/" replace />;
  if (role === 'deployer' && (user.role === 'viewer' || user.isDemo)) return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/docs" element={<Docs />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/security" element={<Security />} />
      <Route path="/docs/:slug" element={<Docs />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify" element={<VerifyEmail />} />
      <Route path="/invite" element={<AcceptInvite />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Overview />} />
        <Route path="instances" element={<Instances />} />
        <Route path="instances/:id" element={<InstanceDetail />} />
        <Route path="instances/:id/apps/:project" element={<AppDetail />} />
        <Route path="instances/:id/access" element={<Protected role="deployer"><Access /></Protected>} />
        <Route path="instances/:id/terminal" element={<Protected role="admin"><Suspense fallback={<div className="text-sm text-slate-500">Loading the terminal…</div>}><Terminal /></Suspense></Protected>} />
        <Route path="instances/:id/new-app" element={<Protected role="admin"><NewApp /></Protected>} />
        <Route path="activity" element={<Activity />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="backups" element={<Backups />} />
        <Route path="costs" element={<Costs />} />
        <Route path="account" element={<Account />} />
        <Route path="github/callback" element={<Protected role="admin"><GithubCallback /></Protected>} />
        <Route path="settings" element={<Protected role="admin"><Settings /></Protected>} />
        <Route path="users" element={<Protected role="admin"><Users /></Protected>} />
        <Route path="team" element={<Team />} />
        <Route path="billing" element={<Protected role="admin"><Billing /></Protected>} />
        <Route path="billing/return" element={<Protected role="admin"><BillingReturn /></Protected>} />
        <Route path="audit" element={<Protected role="admin"><Audit /></Protected>} />
        <Route path="platform" element={<Platform />} />
        <Route path="platform/console" element={<PlatformConsolePage />} />
        <Route path="platform/audit" element={<PlatformAuditPage />} />
        <Route path="platform/workspaces/:id" element={<PlatformWorkspacePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <DialogProvider>
          <App />
        </DialogProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
