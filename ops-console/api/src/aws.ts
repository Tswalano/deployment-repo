import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { AssociateIamInstanceProfileCommand, AuthorizeSecurityGroupIngressCommand, CreateTagsCommand, DescribeInstancesCommand, DescribeSecurityGroupsCommand, EC2Client, RevokeSecurityGroupIngressCommand, RebootInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer';
import { ChangeResourceRecordSetsCommand, GetChangeCommand, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetScheduleCommand, ListSchedulesCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import type { RawCostRow } from './costs';
import type { RawSchedule } from './schedule';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DeleteParameterCommand, DescribeDocumentCommand, DescribeInstanceInformationCommand, DescribeParametersCommand, GetParameterCommand, PutParameterCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient, StartSessionCommand, TerminateSessionCommand } from '@aws-sdk/client-ssm';

/** Everything the console needs from AWS, behind an interface so tests can use a fake. */
export interface AwsProvider {
    describeInstance(region: string, id: string): Promise<Ec2Info | null>;
    ssmOnline(region: string, id: string): Promise<boolean>;
    /** Whether the console's SSM documents are installed in a region (documents are regional). Optional for fakes. */
    documentsReady?(region: string): Promise<boolean>;
    /** Run one of the console's fixed SSM documents (no free-form commands) and return stdout. */
    runDocument(region: string, id: string, document: string, parameters?: Record<string, string[]>, timeoutMs?: number): Promise<string>;
    /** Start a fixed document without waiting (long jobs such as deploys); returns the command id. */
    sendDocument(region: string, id: string, document: string, parameters: Record<string, string[]>): Promise<string>;
    /** Current state of a started command; null while SSM hasn't registered it yet. */
    getInvocation(region: string, id: string, commandId: string): Promise<Invocation | null>;
    /** Start / stop / reboot / terminate. dryRun asks EC2 whether it *would* be allowed, changing nothing. */
    powerAction?(region: string, id: string, action: PowerAction, dryRun: boolean): Promise<void>;
    /** Parameter names/metadata under a path (DescribeParameters: never values). */
    listParameters?(region: string, path: string): Promise<ParamMeta[]>;
    getParameter?(region: string, name: string): Promise<string | null>;
    putParameter?(region: string, name: string, value: string): Promise<void>;
    deleteParameter?(region: string, name: string): Promise<void>;
    /** The console's own settings (/ops-console/*): never simulated, even in local test mode. */
    getConsoleSecret?(region: string, name: string): Promise<string | null>;
    putConsoleSecret?(region: string, name: string, value: string): Promise<void>;
    deleteConsoleSecret?(region: string, name: string): Promise<void>;
    listSchedules?(region: string): Promise<RawSchedule[]>;
    /** Change a schedule's expression and/or state, keeping its target, role and everything else as they are. */
    updateSchedule?(region: string, group: string, name: string, patch: { expression?: string; state?: 'ENABLED' | 'DISABLED' }): Promise<void>;
    /** Daily unblended cost per service, [start, end) as YYYY-MM-DD (Cost Explorer; USD 0.01 per request). */
    costRows?(start: string, end: string): Promise<RawCostRow[]>;
    /** Forecast unblended cost for [start, end) (one request). */
    costForecast?(start: string, end: string): Promise<number | null>;
    /** The public hosted zone for a domain (e.g. glenify.studio), or null. */
    hostedZoneId?(domain: string): Promise<string | null>;
    /** Records with exactly this name in a hosted zone (any type). */
    dnsRecords?(zoneId: string, name: string): Promise<DnsRecord[]>;
    /** Create or update an A record (TTL 60). */
    upsertARecord?(zoneId: string, name: string, ip: string): Promise<string | null>;
    /** Wait until a Route 53 change is live on its name servers (true) or the timeout passes (false). */
    waitDnsChange?(changeId: string, timeoutMs: number): Promise<boolean>;
    /** Delete an A record, only if it still holds exactly this IP (TTL 60, as the console creates them). */
    deleteARecord?(zoneId: string, name: string, ip: string): Promise<void>;
    /** The EC2 instance this console runs on (IMDSv2), or null when not on EC2. */
    selfInstanceId?(): Promise<string | null>;
    /** Start a Session Manager shell (default SSM-SessionManagerRunShell document) on an instance. */
    startSession?(region: string, id: string): Promise<{ sessionId: string; streamUrl: string; tokenValue: string }>;
    terminateSession?(region: string, sessionId: string): Promise<void>;
    /** Security groups attached to an instance, with their SSH (port 22) rules. */
    sshAccess?(region: string, id: string): Promise<SecurityGroupAccess[]>;
    /** Open / close port 22 for one CIDR on a security group (only groups tagged ops-console=managed, by IAM). */
    authorizeSsh?(region: string, groupId: string, cidr: string, description: string): Promise<void>;
    revokeSsh?(region: string, groupId: string, cidr: string): Promise<void>;
    /** Every EC2 instance in a region with what the console needs to know to add it (Phase 12b). */
    listInstances?(region: string): Promise<Ec2Listing[]>;
    /** Tag an instance (and its security groups) ops-console=managed. */
    tagManaged?(region: string, id: string, groupIds: string[]): Promise<void>;
    /** Attach an instance profile to an instance that has none. */
    attachInstanceProfile?(region: string, id: string, profileName: string): Promise<void>;
    /** Short-lived GET link for an object the instance uploaded to the transfer bucket. */
    presignGet(region: string, bucket: string, key: string, seconds: number, filename: string): Promise<string>;
}

export interface ParamMeta { name: string; type: string; version: number; lastModified: string | null; lastModifiedBy: string | null }
export type PowerAction = 'start' | 'stop' | 'reboot' | 'terminate';

export interface Invocation {
    status: 'running' | 'success' | 'failed';
    detail: string;          // SSM's own status, e.g. InProgress, TimedOut
    stdout: string;
    stderr: string;
}

const TERMINAL_FAILED = ['Failed', 'Cancelled', 'TimedOut', 'Cancelling', 'DeliveryTimedOut', 'ExecutionTimedOut', 'Undeliverable', 'Terminated'];

export interface Ec2Info {
    name: string | null;
    state: string;
    type: string;
    az: string;
    managedTag: boolean;
    publicIp?: string | null;
}

export interface SshRule { cidr: string; description: string | null }
export interface SecurityGroupAccess {
    groupId: string; name: string; managedTag: boolean;
    /** Rules that let port 22 in (also all-traffic rules). */
    rules: SshRule[];
    prefixLists: { id: string; description: string | null }[];
    /** Rules that open port 22 to everyone (0.0.0.0/0 or ::/0). */
    openToWorld: boolean;
}

export interface Ec2Listing {
    id: string; name: string | null; state: string; type: string; az: string; publicIp: string | null; platform: string;
    managedTag: boolean; instanceProfile: string | null; ssmOnline: boolean; securityGroups: string[]; launchedAt: string | null;
}

export interface DnsRecord { name: string; type: string; values: string[] }

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const sshPermission = (cidr: string, description?: string) => {
    const v6 = cidr.includes(':');
    const range = description ? { Description: description } : {};
    return { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, ...(v6 ? { Ipv6Ranges: [{ CidrIpv6: cidr, ...range }] } : { IpRanges: [{ CidrIp: cidr, ...range }] }) };
};
function sgError(err: unknown, region: string, groupId: string): string {
    const name = (err as { name?: string }).name;
    if (name === 'InvalidPermission.Duplicate') return 'That address already has SSH access on this security group (an existing rule).';
    if (name === 'UnauthorizedOperation') return `Not permitted: the console may only change security groups tagged ops-console=managed (${groupId} isn't, or the IAM policy ops-console-access is missing).`;
    if (name === 'RulesPerSecurityGroupLimitExceeded') return 'The security group has reached its rule limit.';
    return awsErrorMessage(err, region);
}
function sessionError(err: unknown, region: string): string {
    const name = (err as { name?: string }).name;
    if (name === 'TargetNotConnected') return "The instance isn't connected to Session Manager (is the SSM agent running, and can the instance reach ssmmessages?).";
    if (name === 'AccessDeniedException') return 'Not permitted: the console may only open terminals on instances tagged ops-console=managed (IAM policy ops-console-access).';
    return awsErrorMessage(err, region);
}

/** Turn AWS SDK errors into something a person can act on (some arrive with the message "Unknown"). */
export function awsErrorMessage(err: unknown, region: string): string {
    const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const name = e.name ?? 'Error';
    if (name === 'InvalidDocument') return `The Ops Console SSM documents aren't installed in ${region}. Run: infra/ops-console-ssm/deploy.sh ${region}`;
    if (name === 'AccessDeniedException' || name === 'AccessDenied') return `AWS denied the request in ${region} (${(e.message ?? '').slice(0, 160)}). Check the instance role's ops-console-ssm policy.`;
    if (name === 'InvalidInstanceId') return `SSM can't reach the instance in ${region} (agent offline, or no instance profile with AmazonSSMManagedInstanceCore).`;
    const msg = e.message && e.message !== 'Unknown' && e.message !== 'UnknownError' ? e.message : `HTTP ${e.$metadata?.httpStatusCode ?? '?'}`;
    return `${name}: ${msg}`.slice(0, 300);
}

/**
 * Build a provider. No credentials = the console host's own role (the single-team console, and everything the host
 * does for itself). With credentials = a customer's AWS account (an assumed role, Phase 12b); every client it creates
 * signs with those credentials only.
 */
export function makeAws(credentials?: AwsCredentialIdentityProvider, dry = false): AwsProvider {
    const ec2: Record<string, EC2Client> = {};
    const ssm: Record<string, SSMClient> = {};
    const ec2c = (r: string) => (ec2[r] ??= new EC2Client({ region: r, credentials }));
    const ssmc = (r: string) => (ssm[r] ??= new SSMClient({ region: r, credentials }));
    const sched: Record<string, SchedulerClient> = {};
    const schedc = (r: string) => (sched[r] ??= new SchedulerClient({ region: r, credentials }));
    let ce: CostExplorerClient | null = null;
    const cec = () => (ce ??= new CostExplorerClient({ region: 'us-east-1', credentials }));   // Cost Explorer's only endpoint
    let r53: Route53Client | null = null;
    const r53c = () => (r53 ??= new Route53Client({ region: 'us-east-1', credentials }));   // Route 53 is global
    const s3: Record<string, S3Client> = {};
    const s3c = (r: string) => (s3[r] ??= new S3Client({ region: r, credentials }));
    let selfId: string | null | undefined;
    const real: AwsProvider = {
        async describeInstance(region, id) {
            try {
                const out = await ec2c(region).send(new DescribeInstancesCommand({ InstanceIds: [id] }));
                const i = out.Reservations?.[0]?.Instances?.[0];
                if (!i) return null;
                const tag = (k: string) => i.Tags?.find((t) => t.Key === k)?.Value;
                return {
                    name: tag('Name') ?? null, state: i.State?.Name ?? 'unknown', type: i.InstanceType ?? '?',
                    az: i.Placement?.AvailabilityZone ?? '?', managedTag: tag('ops-console') === 'managed', publicIp: i.PublicIpAddress ?? null,
                };
            } catch (err) {
                if ((err as { name?: string }).name === 'InvalidInstanceID.NotFound' || (err as { name?: string }).name === 'InvalidInstanceID.Malformed') return null;
                throw err;
            }
        },
        async ssmOnline(region, id) {
            const out = await ssmc(region).send(new DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [id] }] }));
            return out.InstanceInformationList?.[0]?.PingStatus === 'Online';
        },
        async powerAction(region, id, action, dryRun) {
            const input = { InstanceIds: [id], DryRun: dryRun };
            const cmd = action === 'start' ? new StartInstancesCommand(input) : action === 'stop' ? new StopInstancesCommand(input)
                : action === 'reboot' ? new RebootInstancesCommand(input) : new TerminateInstancesCommand(input);
            try {
                await ec2c(region).send(cmd as never);
            } catch (err) {
                const name = (err as { name?: string }).name;
                if (dryRun && name === 'DryRunOperation') return;   // "would have succeeded"
                if (name === 'OperationNotPermitted') throw new Error('AWS refused: termination protection is on for this instance (disable it in the EC2 console first).');
                if (name === 'IncorrectInstanceState') throw new Error(`The instance isn't in a state that allows "${action}" right now.`);
                if (name === 'UnauthorizedOperation') throw new Error(`Not permitted: the console may only ${action} instances tagged ops-console=managed.`);
                throw new Error(awsErrorMessage(err, region));
            }
        },
        async listParameters(region, path) {
            const out: ParamMeta[] = [];
            let next: string | undefined;
            do {
                const r = await ssmc(region).send(new DescribeParametersCommand({
                    ParameterFilters: [{ Key: 'Path', Option: 'Recursive', Values: [path] }], MaxResults: 50, NextToken: next,
                })).catch((err) => { throw new Error(awsErrorMessage(err, region)); });
                for (const p of r.Parameters ?? []) {
                    out.push({ name: p.Name!, type: p.Type ?? 'String', version: p.Version ?? 1,
                        lastModified: p.LastModifiedDate ? p.LastModifiedDate.toISOString() : null,
                        lastModifiedBy: p.LastModifiedUser ? p.LastModifiedUser.split(/[:/]/).pop() ?? null : null });
                }
                next = r.NextToken;
            } while (next);
            return out;
        },
        async getParameter(region, name) {
            try {
                const r = await ssmc(region).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
                return r.Parameter?.Value ?? null;
            } catch (err) {
                if ((err as { name?: string }).name === 'ParameterNotFound') return null;
                throw new Error(awsErrorMessage(err, region));
            }
        },
        async putParameter(region, name, value) {
            await ssmc(region).send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }))
                .catch((err) => { throw new Error(awsErrorMessage(err, region)); });
        },
        async listSchedules(region) {
            const out: RawSchedule[] = [];
            let next: string | undefined;
            do {
                const r = await schedc(region).send(new ListSchedulesCommand({ NextToken: next, MaxResults: 100 }))
                    .catch((err) => { throw new Error(awsErrorMessage(err, region)); });
                for (const s of r.Schedules ?? []) {
                    const d = await schedc(region).send(new GetScheduleCommand({ Name: s.Name, GroupName: s.GroupName }));
                    out.push({ name: d.Name!, group: d.GroupName ?? 'default', expression: d.ScheduleExpression ?? '', timezone: d.ScheduleExpressionTimezone ?? 'UTC',
                        state: (d.State as 'ENABLED' | 'DISABLED') ?? 'ENABLED', targetArn: d.Target?.Arn ?? '', input: d.Target?.Input ?? null, description: d.Description ?? null });
                }
                next = r.NextToken;
            } while (next);
            return out;
        },
        async updateSchedule(region, group, name, patch) {
            const d = await schedc(region).send(new GetScheduleCommand({ Name: name, GroupName: group }));
            await schedc(region).send(new UpdateScheduleCommand({
                Name: d.Name!, GroupName: d.GroupName, Description: d.Description, KmsKeyArn: d.KmsKeyArn,
                ScheduleExpression: patch.expression ?? d.ScheduleExpression!, ScheduleExpressionTimezone: d.ScheduleExpressionTimezone,
                StartDate: d.StartDate, EndDate: d.EndDate, State: patch.state ?? d.State, ActionAfterCompletion: d.ActionAfterCompletion,
                FlexibleTimeWindow: d.FlexibleTimeWindow!, Target: d.Target!,
            })).catch((err) => { throw new Error(awsErrorMessage(err, region)); });
        },
        async costRows(start, end) {
            const rows: RawCostRow[] = [];
            let token: string | undefined;
            do {
                const r = await cec().send(new GetCostAndUsageCommand({
                    TimePeriod: { Start: start, End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
                    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }], NextPageToken: token,
                })).catch((err) => { throw new Error(awsErrorMessage(err, 'us-east-1')); });
                for (const day of r.ResultsByTime ?? []) {
                    for (const g of day.Groups ?? []) {
                        const m = g.Metrics?.UnblendedCost;
                        rows.push({ day: day.TimePeriod!.Start!, service: g.Keys?.[0] ?? 'Other', amount: Number(m?.Amount ?? 0), unit: m?.Unit ?? 'USD' });
                    }
                }
                token = r.NextPageToken;
            } while (token);
            return rows;
        },
        async costForecast(start, end) {
            const r = await cec().send(new GetCostForecastCommand({ TimePeriod: { Start: start, End: end }, Metric: 'UNBLENDED_COST', Granularity: 'MONTHLY' }));
            return r.Total?.Amount ? Number(r.Total.Amount) : null;
        },
        async deleteParameter(region, name) {
            await ssmc(region).send(new DeleteParameterCommand({ Name: name })).catch((err) => {
                if ((err as { name?: string }).name === 'ParameterNotFound') return;
                throw new Error(awsErrorMessage(err, region));
            });
        },
        async getConsoleSecret(region, name) {
            if (!name.startsWith('/ops-console/')) throw new Error('not a console parameter');
            return real.getParameter!(region, name);
        },
        async putConsoleSecret(region, name, value) {
            if (!name.startsWith('/ops-console/')) throw new Error('not a console parameter');
            return real.putParameter!(region, name, value);
        },
        async deleteConsoleSecret(region, name) {
            if (!name.startsWith('/ops-console/')) throw new Error('not a console parameter');
            return real.deleteParameter!(region, name);
        },
        async hostedZoneId(domain) {
            const r = await r53c().send(new ListHostedZonesByNameCommand({ DNSName: `${domain}.`, MaxItems: 1 }))
                .catch((err) => { throw new Error(awsErrorMessage(err, 'route53')); });
            const z = r.HostedZones?.[0];
            return z && z.Name === `${domain}.` && !z.Config?.PrivateZone ? (z.Id ?? '').replace('/hostedzone/', '') : null;
        },
        async dnsRecords(zoneId, name) {
            const fq = name.endsWith('.') ? name : `${name}.`;
            const r = await r53c().send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: fq, MaxItems: 10 }))
                .catch((err) => { throw new Error(awsErrorMessage(err, 'route53')); });
            return (r.ResourceRecordSets ?? []).filter((x) => x.Name === fq)
                .map((x) => ({ name, type: x.Type ?? '?', values: (x.ResourceRecords ?? []).map((v) => v.Value ?? '').concat(x.AliasTarget?.DNSName ? [x.AliasTarget.DNSName] : []) }));
        },
        async upsertARecord(zoneId, name, ip) {
            const r = await r53c().send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: {
                Comment: 'ops-console: new app',
                Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: name, Type: 'A', TTL: 60, ResourceRecords: [{ Value: ip }] } }],
            } })).catch((err) => { throw new Error(awsErrorMessage(err, 'route53')); });
            return r.ChangeInfo?.Id ?? null;
        },
        async waitDnsChange(changeId, timeoutMs) {
            const end = Date.now() + timeoutMs;
            while (Date.now() < end) {
                const r = await r53c().send(new GetChangeCommand({ Id: changeId })).catch(() => null);
                if (r?.ChangeInfo?.Status === 'INSYNC') return true;
                await sleep(5000);
            }
            return false;
        },
        async deleteARecord(zoneId, name, ip) {
            const recs = await real.dnsRecords!(zoneId, name);
            const a = recs.find((x) => x.type === 'A');
            if (!a || a.values.length !== 1 || a.values[0] !== ip) return;   // changed by someone else since: leave it
            await r53c().send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: {
                Comment: 'ops-console: remove the record of an app whose creation failed',
                Changes: [{ Action: 'DELETE', ResourceRecordSet: { Name: name, Type: 'A', TTL: 60, ResourceRecords: [{ Value: ip }] } }],
            } })).catch((err) => { throw new Error(awsErrorMessage(err, 'route53')); });
        },
        async selfInstanceId() {
            if (selfId !== undefined) return selfId;
            try {
                const token = await (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(1000) })).text();
                const id = await (await fetch('http://169.254.169.254/latest/meta-data/instance-id', { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) })).text();
                selfId = /^i-[0-9a-f]+$/.test(id) ? id : null;
            } catch { selfId = null; }
            return selfId;
        },
        async documentsReady(region) {
            try {
                await ssmc(region).send(new DescribeDocumentCommand({ Name: 'OpsConsole-CollectStatus' }));
                return true;
            } catch (err) {
                if ((err as { name?: string }).name === 'InvalidDocument') return false;
                throw new Error(awsErrorMessage(err, region));
            }
        },
        async sendDocument(region, id, document, parameters) {
            const sent = await ssmc(region).send(new SendCommandCommand({
                InstanceIds: [id], DocumentName: document, Parameters: parameters, TimeoutSeconds: 60, Comment: 'ops-console',
            })).catch((err) => { throw new Error(awsErrorMessage(err, region)); });
            const commandId = sent.Command?.CommandId;
            if (!commandId) throw new Error('SSM did not return a command id');
            return commandId;
        },
        async getInvocation(region, id, commandId) {
            try {
                const inv = await ssmc(region).send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: id }));
                const detail = inv.Status ?? 'Pending';
                const status = detail === 'Success' ? 'success' : TERMINAL_FAILED.includes(detail) ? 'failed' : 'running';
                return { status, detail, stdout: inv.StandardOutputContent ?? '', stderr: inv.StandardErrorContent ?? '' };
            } catch (err) {
                if ((err as { name?: string }).name === 'InvocationDoesNotExist') return null;
                throw err;
            }
        },
        async startSession(region, id) {
            const r = await ssmc(region).send(new StartSessionCommand({ Target: id, Reason: 'ops-console terminal' }))
                .catch((err) => { throw new Error(sessionError(err, region)); });
            if (!r.SessionId || !r.StreamUrl || !r.TokenValue) throw new Error('Session Manager did not return a session');
            return { sessionId: r.SessionId, streamUrl: r.StreamUrl, tokenValue: r.TokenValue };
        },
        async terminateSession(region, sessionId) {
            await ssmc(region).send(new TerminateSessionCommand({ SessionId: sessionId })).catch(() => undefined);
        },
        async sshAccess(region, id) {
            const out = await ec2c(region).send(new DescribeInstancesCommand({ InstanceIds: [id] })).catch((err) => { throw new Error(awsErrorMessage(err, region)); });
            const ids = (out.Reservations?.[0]?.Instances?.[0]?.SecurityGroups ?? []).map((g) => g.GroupId!).filter(Boolean);
            if (!ids.length) return [];
            const sgs = await ec2c(region).send(new DescribeSecurityGroupsCommand({ GroupIds: ids })).catch((err) => { throw new Error(awsErrorMessage(err, region)); });
            return (sgs.SecurityGroups ?? []).map((g) => {
                const perms = (g.IpPermissions ?? []).filter((p) => p.IpProtocol === '-1' || (p.IpProtocol === 'tcp' && (p.FromPort ?? 0) <= 22 && (p.ToPort ?? 0) >= 22));
                const rules = perms.flatMap((p) => [
                    ...(p.IpRanges ?? []).map((r) => ({ cidr: r.CidrIp!, description: r.Description ?? null })),
                    ...(p.Ipv6Ranges ?? []).map((r) => ({ cidr: r.CidrIpv6!, description: r.Description ?? null })),
                ]).filter((r) => r.cidr);
                return {
                    groupId: g.GroupId!, name: g.GroupName ?? g.GroupId!, managedTag: !!g.Tags?.some((t) => t.Key === 'ops-console' && t.Value === 'managed'),
                    rules, prefixLists: perms.flatMap((p) => (p.PrefixListIds ?? []).map((l) => ({ id: l.PrefixListId!, description: l.Description ?? null }))),
                    openToWorld: rules.some((r) => r.cidr === '0.0.0.0/0' || r.cidr === '::/0'),
                };
            });
        },
        async authorizeSsh(region, groupId, cidr, description) {
            await ec2c(region).send(new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [sshPermission(cidr, description)] }))
                .catch((err) => { throw new Error(sgError(err, region, groupId)); });
        },
        async revokeSsh(region, groupId, cidr) {
            await ec2c(region).send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [sshPermission(cidr)] }))
                .catch((err) => {
                    if ((err as { name?: string }).name === 'InvalidPermission.NotFound') return;   // already gone
                    throw new Error(sgError(err, region, groupId));
                });
        },
        async listInstances(region) {
            const out: Ec2Listing[] = [];
            let NextToken: string | undefined;
            do {
                const r = await ec2c(region).send(new DescribeInstancesCommand({ NextToken, MaxResults: 200,
                    Filters: [{ Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }))
                    .catch((err) => { throw new Error(awsErrorMessage(err, region)); });
                for (const i of (r.Reservations ?? []).flatMap((x) => x.Instances ?? [])) {
                    const tag = (k: string) => i.Tags?.find((t) => t.Key === k)?.Value;
                    out.push({ id: i.InstanceId!, name: tag('Name') ?? null, state: i.State?.Name ?? '?', type: i.InstanceType ?? '?', az: i.Placement?.AvailabilityZone ?? '?',
                        publicIp: i.PublicIpAddress ?? null, platform: i.PlatformDetails ?? 'Linux/UNIX', managedTag: tag('ops-console') === 'managed',
                        instanceProfile: i.IamInstanceProfile?.Arn?.split('/').pop() ?? null, ssmOnline: false,
                        securityGroups: (i.SecurityGroups ?? []).map((g) => g.GroupId!).filter(Boolean), launchedAt: i.LaunchTime?.toISOString() ?? null });
                }
                NextToken = r.NextToken;
            } while (NextToken);
            if (out.length) {
                const online = new Set<string>();
                let t: string | undefined;
                do {
                    const r = await ssmc(region).send(new DescribeInstanceInformationCommand({ NextToken: t, MaxResults: 50 })).catch(() => null);
                    for (const x of r?.InstanceInformationList ?? []) if (x.PingStatus === 'Online' && x.InstanceId) online.add(x.InstanceId);
                    t = r?.NextToken;
                } while (t);
                for (const o of out) o.ssmOnline = online.has(o.id);
            }
            return out;
        },
        async tagManaged(region, id, groupIds) {
            await ec2c(region).send(new CreateTagsCommand({ Resources: [id, ...groupIds], Tags: [{ Key: 'ops-console', Value: 'managed' }] }))
                .catch((err) => { throw new Error(awsErrorMessage(err, region)); });
        },
        async attachInstanceProfile(region, id, profileName) {
            await ec2c(region).send(new AssociateIamInstanceProfileCommand({ InstanceId: id, IamInstanceProfile: { Name: profileName } }))
                .catch((err) => { throw new Error(awsErrorMessage(err, region)); });
        },
        async presignGet(region, bucket, key, seconds, filename) {
            return getSignedUrl(s3c(region), new GetObjectCommand({
                Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, '')}"`,
            }), { expiresIn: seconds });
        },
        async runDocument(region, id, document, parameters, timeoutMs = 45_000) {
            const commandId = await this.sendDocument(region, id, document, parameters ?? {});
            const deadline = Date.now() + timeoutMs;
            await sleep(1200);
            while (Date.now() < deadline) {
                const inv = await this.getInvocation(region, id, commandId);
                if (inv?.status === 'success') return inv.stdout;
                if (inv?.status === 'failed') throw new Error(`SSM command ${inv.detail}: ${(inv.stderr || inv.stdout).slice(-500)}`);
                await sleep(1500);
            }
            throw new Error('SSM command timed out');
        },
    };

    if (!dry) return real;
    const dryAware: AwsProvider = {
        ...realAws,
        async sendDocument(region, id, document, parameters) {
            if (document !== 'OpsConsole-Deploy' && document !== 'OpsConsole-CreateApp') return real.sendDocument(region, id, document, parameters);
            const cid = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const p = (k: string) => parameters[k]?.[0] ?? '';
            simulated.set(cid, { at: Date.now(), text: document === 'OpsConsole-CreateApp'
                ? `DRY RUN (local test mode): nothing was changed.\nWould clone ${p('repo')}@${p('branch')} into /opt/apps/${p('project')}, create the service, ${p('db') === 'yes' ? 'a database, ' : ''}nginx + HTTPS for ${p('domain')} and run the first deploy.\n${JSON.stringify({ ok: true, step: 'done', error: null, port: 5000, tls: true, database: p('db') === 'yes' ? p('project').replace(/-/g, '_') : null, domain: p('domain'), dryRun: true })}`
                : `DRY RUN (local test mode): nothing was changed.\nWould run: pipeline.sh ${p('action')} ${p('project')} ${p('ref')}\nactor=${p('actor')}` });
            return cid;
        },
        async getInvocation(region, id, commandId) {
            const s = simulated.get(commandId);
            if (!s) return real.getInvocation(region, id, commandId);
            return Date.now() - s.at < 15_000
                ? { status: 'running', detail: 'InProgress', stdout: '', stderr: '' }
                : { status: 'success', detail: 'Success', stdout: s.text, stderr: '' };
        },
        async powerAction(region, id, action) {
            return real.powerAction!(region, id, action, true);
        },
        // local test mode: ask EC2 whether the rule change *would* be allowed (DryRun), change nothing
        async authorizeSsh(region, groupId, cidr, description) {
            await ec2c(region).send(new AuthorizeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [sshPermission(cidr, description)], DryRun: true }))
                .catch((err) => { if ((err as { name?: string }).name !== 'DryRunOperation') throw new Error(sgError(err, region, groupId)); });
        },
        async revokeSsh(region, groupId, cidr) {
            await ec2c(region).send(new RevokeSecurityGroupIngressCommand({ GroupId: groupId, IpPermissions: [sshPermission(cidr)], DryRun: true }))
                .catch((err) => { if (!['DryRunOperation', 'InvalidPermission.NotFound'].includes((err as { name?: string }).name ?? '')) throw new Error(sgError(err, region, groupId)); });
        },
        async putParameter() { /* local test mode: never write app secrets */ },
        async upsertARecord() { return null; /* local test mode: never change DNS */ },
        async waitDnsChange() { return true; },
        async deleteARecord() { /* local test mode */ },
            async tagManaged() { /* local test mode: never tag */ },
            async attachInstanceProfile() { /* local test mode */ },
        async deleteParameter() { /* local test mode */ },
        async runDocument(region, id, document, parameters, timeoutMs) {
            if (document === 'OpsConsole-RotateSecret') {
                return JSON.stringify({ ok: true, kind: parameters?.kind?.[0], target: parameters?.target?.[0], dryRun: true, updated: [], restarted: [], health: {} });
            }
            if (document === 'OpsConsole-SshKeys') {
                return JSON.stringify({ ok: true, action: parameters?.action?.[0], user: parameters?.user?.[0], fingerprint: parameters?.fingerprint?.[0] || 'SHA256:(dry run)', dryRun: true });
            }
            if (document === 'OpsConsole-BackupAction' && parameters?.action?.[0] === 'run') {
                return JSON.stringify({ ok: true, seconds: 0, status: { at: new Date().toISOString(), ok: true, dryRun: true } });
            }
            return real.runDocument.call(dryAware, region, id, document, parameters, timeoutMs);
        },
    };

    return dryAware;
}

export const realAws = makeAws();

/**
 * Local test mode (OPS_DRY_RUN=1): anything that changes the instance is simulated. Deploys/rollbacks "run" for
 * 15 seconds and succeed; "Back up now" returns at once. Read-only documents and restore tests/exports (which never
 * touch live data) still run for real.
 */
export const dryRun = process.env.OPS_DRY_RUN === '1';
const simulated = new Map<string, { at: number; text: string }>();

let provider: AwsProvider = dryRun ? makeAws(undefined, true) : realAws;

/**
 * Multi-tenant mode: the console's own AWS role belongs to whoever hosts it, never to a customer's workspace.
 * Until a workspace connects its own AWS account (Phase 12b), every AWS call is refused here, at the source.
 */
export const NO_AWS_MESSAGE = 'Connect your AWS account first: this workspace has no AWS access yet.';
const refuseAll = new Proxy({} as AwsProvider, {
    get: (_t, prop) => (prop === 'then' ? undefined : async () => { throw Object.assign(new Error(NO_AWS_MESSAGE), { name: 'NoAwsAccount' }); }),
});
let multiTenantGuard = process.env.OPS_MULTI_TENANT === '1' || process.env.OPS_MULTI_TENANT === 'true';
/** Multi-tenant: set by connections.ts (kept out of this module to avoid an import cycle). */
let workspaceResolver: (() => Promise<AwsProvider | null>) | null = null;
export function setWorkspaceResolver(r: () => Promise<AwsProvider | null>): void { workspaceResolver = r; }
/** Multi-tenant: every call resolves the CURRENT workspace's own AWS account (or is refused when it has none). */
const perWorkspace = new Proxy({} as AwsProvider, {
    get: (_t, prop) => (prop === 'then' ? undefined : async (...args: unknown[]) => {
        const p = workspaceResolver ? await workspaceResolver() : null;
        const fn = p?.[prop as keyof AwsProvider] as ((...a: unknown[]) => Promise<unknown>) | undefined;
        if (!p) throw Object.assign(new Error(NO_AWS_MESSAGE), { name: 'NoAwsAccount' });
        if (typeof fn !== 'function') throw new Error(`${String(prop)} is not available`);
        return fn.apply(p, args);
    }),
});
export const aws = () => (multiTenantGuard ? (workspaceResolver ? perWorkspace : refuseAll) : provider);
/** Tests: switch the guard (it follows OPS_MULTI_TENANT otherwise). */
export function setMultiTenantGuard(on: boolean): void {
    multiTenantGuard = on;
}
/** Tests: swap in a fake. */
export function setAwsProvider(p: AwsProvider): void {
    provider = p;
}
