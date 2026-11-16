import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Account } from './pages/Account';
import { Activity } from './pages/Activity';
import { Alerts } from './pages/Alerts';
import { AppDetail } from './pages/AppDetail';
import { Audit } from './pages/Audit';
import { Backups } from './pages/Backups';
import { InstanceDetail } from './pages/InstanceDetail';
import { Instances } from './pages/Instances';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Secrets } from './pages/Secrets';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import type { Role } from './api';
import './index.css';

function Protected({ children, role }: { children: JSX.Element; role?: Role }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid h-screen place-items-center text-sm text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (role === 'admin' && user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Overview />} />
        <Route path="instances" element={<Instances />} />
        <Route path="instances/:id" element={<InstanceDetail />} />
        <Route path="instances/:id/apps/:project" element={<AppDetail />} />
        <Route path="activity" element={<Activity />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="backups" element={<Backups />} />
        <Route path="secrets" element={<Secrets />} />
        <Route path="account" element={<Account />} />
        <Route path="settings" element={<Protected role="admin"><Settings /></Protected>} />
        <Route path="users" element={<Protected role="admin"><Users /></Protected>} />
        <Route path="audit" element={<Protected role="admin"><Audit /></Protected>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
