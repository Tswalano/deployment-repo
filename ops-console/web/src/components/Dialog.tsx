import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * In-app dialogs instead of the browser's alert/confirm/prompt (which look foreign and can't be styled):
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm({ title: 'Remove key?', body: '…', confirmLabel: 'Remove', danger: true }))) return;
 *   const name = await dialog.prompt({ title: 'New workspace', label: 'Name', minLength: 2 });   // null = cancelled
 *   await dialog.alert({ title: 'Could not create it', body: message });
 */
export interface ConfirmOptions { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
export interface PromptOptions extends ConfirmOptions {
  label: string; placeholder?: string; defaultValue?: string; type?: 'text' | 'password' | 'email'; minLength?: number; required?: boolean; hint?: ReactNode; maxLength?: number;
}
interface Api {
  confirm(o: ConfirmOptions): Promise<boolean>;
  prompt(o: PromptOptions): Promise<string | null>;
  alert(o: { title: string; body?: ReactNode; okLabel?: string }): Promise<void>;
}
type Open = { kind: 'confirm'; o: ConfirmOptions; done: (v: boolean) => void }
  | { kind: 'prompt'; o: PromptOptions; done: (v: string | null) => void }
  | { kind: 'alert'; o: { title: string; body?: ReactNode; okLabel?: string }; done: () => void };

const Ctx = createContext<Api | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const api: Api = {
    confirm: useCallback((o) => new Promise<boolean>((done) => setOpen({ kind: 'confirm', o, done })), []),
    prompt: useCallback((o) => new Promise<string | null>((done) => setOpen({ kind: 'prompt', o, done })), []),
    alert: useCallback((o) => new Promise<void>((done) => setOpen({ kind: 'alert', o, done })), []),
  };
  return (
    <Ctx.Provider value={api}>
      {children}
      {open && <DialogView open={open} close={() => setOpen(null)} />}
    </Ctx.Provider>
  );
}

export function useDialog(): Api {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDialog needs <DialogProvider>');
  return c;
}

function DialogView({ open, close }: { open: Open; close: () => void }) {
  const [value, setValue] = useState(open.kind === 'prompt' ? open.o.defaultValue ?? '' : '');
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(document.activeElement);
  const cancel = useCallback(() => {
    if (open.kind === 'confirm') open.done(false); else if (open.kind === 'prompt') open.done(null); else open.done();
    close();
  }, [open, close]);
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>('input, button[data-primary]');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      if (e.key === 'Tab' && panel.current) {   // keep focus inside the dialog
        const els = [...panel.current.querySelectorAll<HTMLElement>('input, button')].filter((x) => !x.hasAttribute('disabled'));
        if (!els.length) return;
        const [a, b] = [els[0], els[els.length - 1]];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const back = restore.current;
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = prev; (back as HTMLElement | null)?.focus?.(); };
  }, [cancel]);

  const o = open.o;
  const p = open.kind === 'prompt' ? open.o : null;
  const tooShort = !!p && (((p.required ?? true) && !value.trim()) || (p.minLength != null && value.trim().length < p.minLength));
  const ok = () => {
    if (open.kind === 'confirm') open.done(true);
    else if (open.kind === 'prompt') { if (tooShort) return; open.done(p!.type === 'password' ? value : value.trim()); }
    else open.done();
    close();
  };
  const danger = open.kind !== 'alert' && (o as ConfirmOptions).danger;
  const okLabel = open.kind === 'alert' ? open.o.okLabel ?? 'OK' : (o as ConfirmOptions).confirmLabel ?? (open.kind === 'prompt' ? 'Save' : 'Confirm');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div ref={panel} role={open.kind === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="dlg-title"
           className="w-full max-w-md rounded-2xl border border-ink-600 bg-ink-900 p-6 shadow-2xl shadow-black/50">
        <h2 id="dlg-title" className="text-base font-semibold text-slate-100">{o.title}</h2>
        {o.body && <div className="mt-2 text-sm leading-6 text-slate-400">{o.body}</div>}
        <form className="mt-5" onSubmit={(e) => { e.preventDefault(); ok(); }}>
          {p && (
            <div className="mb-5">
              <label htmlFor="dlg-input" className="label">{p.label}</label>
              <input id="dlg-input" className="input" type={p.type ?? 'text'} value={value} placeholder={p.placeholder} maxLength={p.maxLength ?? 300}
                     autoComplete={p.type === 'password' ? 'new-password' : 'off'} onChange={(e) => setValue(e.target.value)} />
              {p.hint && <p className="mt-1.5 text-xs text-slate-500">{p.hint}</p>}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {open.kind !== 'alert' && <button type="button" className="btn-ghost" onClick={cancel}>{(o as ConfirmOptions).cancelLabel ?? 'Cancel'}</button>}
            <button type="submit" data-primary className={danger ? 'btn-danger' : 'btn-primary'} disabled={tooShort}>{okLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
