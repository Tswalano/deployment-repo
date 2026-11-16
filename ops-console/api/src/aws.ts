import { DescribeInstancesCommand, EC2Client, RebootInstancesCommand, StartInstancesCommand, StopInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DescribeDocumentCommand, DescribeInstanceInformationCommand, DescribeParametersCommand, GetParameterCommand, PutParameterCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';

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
    /** The EC2 instance this console runs on (IMDSv2), or null when not on EC2. */
    selfInstanceId?(): Promise<string | null>;
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
}

const ec2: Record<string, EC2Client> = {};
const ssm: Record<string, SSMClient> = {};
const ec2c = (r: string) => (ec2[r] ??= new EC2Client({ region: r }));
const ssmc = (r: string) => (ssm[r] ??= new SSMClient({ region: r }));
const s3: Record<string, S3Client> = {};
const s3c = (r: string) => (s3[r] ??= new S3Client({ region: r }));
let selfId: string | null | undefined;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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

export const realAws: AwsProvider = {
    async describeInstance(region, id) {
        try {
            const out = await ec2c(region).send(new DescribeInstancesCommand({ InstanceIds: [id] }));
            const i = out.Reservations?.[0]?.Instances?.[0];
            if (!i) return null;
            const tag = (k: string) => i.Tags?.find((t) => t.Key === k)?.Value;
            return {
                name: tag('Name') ?? null, state: i.State?.Name ?? 'unknown', type: i.InstanceType ?? '?',
                az: i.Placement?.AvailabilityZone ?? '?', managedTag: tag('ops-console') === 'managed',
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

/**
 * Local test mode (OPS_DRY_RUN=1): anything that changes the instance is simulated. Deploys/rollbacks "run" for
 * 15 seconds and succeed; "Back up now" returns at once. Read-only documents and restore tests/exports (which never
 * touch live data) still run for real.
 */
export const dryRun = process.env.OPS_DRY_RUN === '1';
const simulated = new Map<string, { at: number; text: string }>();
const dryAware: AwsProvider = {
    ...realAws,
    async sendDocument(region, id, document, parameters) {
        if (document !== 'OpsConsole-Deploy') return realAws.sendDocument(region, id, document, parameters);
        const cid = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const p = (k: string) => parameters[k]?.[0] ?? '';
        simulated.set(cid, { at: Date.now(), text: `DRY RUN (local test mode): nothing was changed.\nWould run: pipeline.sh ${p('action')} ${p('project')} ${p('ref')}\nactor=${p('actor')}` });
        return cid;
    },
    async getInvocation(region, id, commandId) {
        const s = simulated.get(commandId);
        if (!s) return realAws.getInvocation(region, id, commandId);
        return Date.now() - s.at < 15_000
            ? { status: 'running', detail: 'InProgress', stdout: '', stderr: '' }
            : { status: 'success', detail: 'Success', stdout: s.text, stderr: '' };
    },
    async powerAction(region, id, action) {
        return realAws.powerAction!(region, id, action, true);
    },
    async putParameter() { /* local test mode: never write secrets */ },
    async runDocument(region, id, document, parameters, timeoutMs) {
        if (document === 'OpsConsole-RotateSecret') {
            return JSON.stringify({ ok: true, kind: parameters?.kind?.[0], target: parameters?.target?.[0], dryRun: true, updated: [], restarted: [], health: {} });
        }
        if (document === 'OpsConsole-BackupAction' && parameters?.action?.[0] === 'run') {
            return JSON.stringify({ ok: true, seconds: 0, status: { at: new Date().toISOString(), ok: true, dryRun: true } });
        }
        return realAws.runDocument.call(dryAware, region, id, document, parameters, timeoutMs);
    },
};

let provider: AwsProvider = dryRun ? dryAware : realAws;
export const aws = () => provider;
/** Tests: swap in a fake. */
export function setAwsProvider(p: AwsProvider): void {
    provider = p;
}
