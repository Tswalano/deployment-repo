import { ThemeToggle } from '../components/ThemeToggle';
import { ReactNode, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

const UPDATED = '17 November 2026';
const H = ({ children }: { children: ReactNode }) => <h2 className="mt-10 text-lg font-semibold text-slate-100">{children}</h2>;
const P = ({ children }: { children: ReactNode }) => <p className="mt-3 leading-7 text-slate-300">{children}</p>;
const UL = ({ children }: { children: ReactNode }) => <ul className="mt-3 list-disc space-y-1.5 pl-5 leading-7 text-slate-300">{children}</ul>;

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { site, user } = useAuth();
  useEffect(() => { window.scrollTo(0, 0); }, [title]);
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-700">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-4 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-indigo-400/40 bg-indigo-500/15 text-indigo-300">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3 3 20h18L12 3z" /></svg>
            </span>
            <span className="font-semibold text-slate-100">{site.productName}</span>
          </Link>
          <div className="ml-auto flex items-center gap-2"><ThemeToggle />{user ? <Link to="/" className="btn-secondary">Open the console</Link> : <Link to="/login" className="btn-ghost">Sign in</Link>}</div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-100">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated {UPDATED}</p>
        {children}
      </main>
      <LegalLinks />
    </div>
  );
}

export function LegalLinks() {
  const { site } = useAuth();
  return (
    <footer className="border-t border-ink-700">
      <div className="mx-auto flex max-w-4xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-xs text-slate-500 sm:px-6">
        <span>© {new Date().getFullYear()} {site.legalEntity ?? site.productName}</span>
        <Link to="/terms" className="hover:text-slate-300">Terms of Service</Link>
        <Link to="/privacy" className="hover:text-slate-300">Privacy Policy</Link>
        <Link to="/security" className="hover:text-slate-300">Security</Link>
        <Link to="/docs" className="hover:text-slate-300">Documentation</Link>
      </div>
    </footer>
  );
}

const contact = (email: string | null | undefined) => (email ? <a className="text-indigo-300 hover:underline" href={`mailto:${email}`}>{email}</a> : 'the contact details published on this site');

export function Terms() {
  const { site } = useAuth();
  const who = site.legalEntity ?? site.productName;
  return (
    <Shell title="Terms of Service">
      <P>These terms govern the use of {site.productName} (the "Service"), provided by {who} ("the Provider"). By creating an account or using the Service, the customer agrees to these terms on behalf of the organisation it represents.</P>
      <H>1. The Service</H>
      <P>The Service deploys, monitors and manages applications on servers in the customer's own Amazon Web Services (AWS) account. The customer's infrastructure, data and costs remain in that account and are billed by AWS directly. The Provider is not responsible for AWS charges or for the availability of AWS.</P>
      <H>2. Accounts</H>
      <UL>
        <li>Account holders must provide accurate information and keep credentials confidential.</li>
        <li>The customer is responsible for all activity in its workspace and for the people it invites.</li>
        <li>Accounts may not be shared between individuals.</li>
      </UL>
      <H>3. Access to the customer's AWS account</H>
      <P>The Service accesses the customer's AWS account only through the access role the customer creates, within the permissions of that role. The customer may revoke access at any time by deleting the role. The customer remains responsible for the security configuration of its AWS account.</P>
      <H>4. Subscriptions and payment</H>
      <UL>
        <li>Paid plans are billed monthly in advance in South African Rand through Paystack. Prices may change with at least 30 days' notice.</li>
        <li>A free trial, where offered, ends automatically; no charge is made unless a plan is chosen.</li>
        <li>If a payment fails, a 7-day grace period applies, after which the workspace becomes read-only until payment is made.</li>
        <li>Subscriptions can be cancelled at any time and remain active until the end of the paid period. Payments already made are not refunded, except where required by law.</li>
      </UL>
      <H>5. Acceptable use</H>
      <P>The Service may not be used for unlawful activity, to distribute malware, to attack or disrupt other systems, to infringe intellectual property, or in breach of AWS or GitHub terms. The Provider may suspend accounts that breach these rules.</P>
      <H>6. Customer content</H>
      <P>The customer retains all rights to its code, data and content. The customer grants the Provider only the rights needed to operate the Service.</P>
      <H>7. Availability and support</H>
      <P>The Provider aims to keep the Service available and secure but does not guarantee uninterrupted operation. Applications continue to run on the customer's servers when the Service is unavailable.</P>
      <H>8. Limitation of liability</H>
      <P>To the extent permitted by law, the Provider is not liable for indirect or consequential losses, loss of data or loss of profit, and its total liability is limited to the fees paid for the Service in the three months before the claim.</P>
      <H>9. Termination</H>
      <P>The customer may stop using the Service at any time. The Provider may terminate accounts that breach these terms. On termination, access to the workspace ends; the customer's servers and data remain in its AWS account.</P>
      <H>10. Governing law</H>
      <P>These terms are governed by the laws of the Republic of South Africa.</P>
      <H>11. Contact</H>
      <P>Questions about these terms: {contact(site.supportEmail)}.</P>
    </Shell>
  );
}

export function Privacy() {
  const { site } = useAuth();
  const who = site.legalEntity ?? site.productName;
  return (
    <Shell title="Privacy Policy">
      <P>This policy explains how {who} ("the Provider") processes personal information in {site.productName}, in line with the Protection of Personal Information Act, 2013 (POPIA).</P>
      <H>Information collected</H>
      <UL>
        <li><b>Account information</b>: name, username, email address and encrypted password.</li>
        <li><b>Workspace information</b>: workspace name, team memberships and roles.</li>
        <li><b>Operational records</b>: audit-log entries (actions, times and IP addresses), sign-in records and terminal session records (who and when; keystrokes are not recorded).</li>
        <li><b>Billing information</b>: plan, invoices and payment status. Card details are handled by Paystack and are not stored by the Provider.</li>
      </UL>
      <H>Information not collected</H>
      <P>Application code, databases, backups and secrets stay on the customer's servers and in its AWS account. The Service reads server and application status to display it, but does not copy customer databases.</P>
      <H>Purpose</H>
      <P>Personal information is used to provide and secure the Service, to send account and service emails (confirmation, invitations, password resets, alerts and receipts), and to meet legal and accounting obligations. It is not sold.</P>
      <H>Service providers</H>
      <UL>
        <li>Amazon Web Services: hosting and email delivery.</li>
        <li>Paystack: payment processing.</li>
        <li>GitHub: repository access, when connected by the customer.</li>
        <li>Anthropic: answers questions asked in &ldquo;Ask Ops Console&rdquo; (the question, and the workspace status the assistant looks up to answer it; never setting values or other secrets).</li>
      </UL>
      <H>Retention</H>
      <P>Account and audit information is kept while the account is active and as long as required for legal and accounting purposes afterwards. Invoices are kept as required by tax law.</P>
      <H>Security</H>
      <P>Data is encrypted in transit, passwords are stored as one-way hashes, and each workspace's data is isolated at the database level. See <Link className="text-indigo-300 hover:underline" to="/security">Security</Link>.</P>
      <H>Rights</H>
      <P>Under POPIA, individuals may request access to, correction of or deletion of their personal information, and may object to its processing. Complaints may also be lodged with the Information Regulator of South Africa.</P>
      <H>Contact</H>
      <P>Privacy requests and questions: {contact(site.supportEmail)}.</P>
    </Shell>
  );
}

export function Security() {
  const { site } = useAuth();
  return (
    <Shell title="Security">
      <P>{site.productName} is designed so that customers keep control of their infrastructure and data.</P>
      <H>Access to AWS</H>
      <UL>
        <li>No AWS access keys are stored. The Service uses a role created in the customer's account, with short-lived credentials.</li>
        <li>Each workspace has a unique, secret external ID; the role works only with that ID.</li>
        <li>The role is limited to the Service's published commands on servers the customer has added. Deleting the role removes access immediately.</li>
      </UL>
      <H>Isolation</H>
      <P>Each workspace's data is separated by row-level security in the database, so one workspace cannot read or change another's data.</P>
      <H>Accounts and sessions</H>
      <UL>
        <li>Passwords are stored as salted one-way hashes; repeated failed sign-ins lock the account temporarily.</li>
        <li>Session cookies are HTTP-only and secure; all requests that change data are checked against the site of origin.</li>
        <li>Roles limit what each team member can do, and every significant action is recorded in the audit log.</li>
      </UL>
      <H>Servers</H>
      <UL>
        <li>The browser terminal uses AWS Session Manager, so no SSH port needs to be open.</li>
        <li>Temporary SSH access and laptop keys expire automatically.</li>
        <li>Server software is installed from a release bundle whose checksum is verified before installation.</li>
      </UL>
      <H>Reporting a vulnerability</H>
      <P>Security issues can be reported to {contact(site.supportEmail)}. Reports are investigated promptly.</P>
    </Shell>
  );
}
