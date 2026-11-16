import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Everything the console needs from AWS, behind an interface so tests can use a fake. */
export interface AwsProvider {
    describeInstance(region: string, id: string): Promise<Ec2Info | null>;
    ssmOnline(region: string, id: string): Promise<boolean>;
    /** Run one of the console's fixed SSM documents (no free-form commands) and return stdout. */
    runDocument(region: string, id: string, document: string, parameters?: Record<string, string[]>, timeoutMs?: number): Promise<string>;
    /** Start a fixed document without waiting (long jobs such as deploys); returns the command id. */
    sendDocument(region: string, id: string, document: string, parameters: Record<string, string[]>): Promise<string>;
    /** Current state of a started command; null while SSM hasn't registered it yet. */
    getInvocation(region: string, id: string, commandId: string): Promise<Invocation | null>;
    /** Short-lived GET link for an object the instance uploaded to the transfer bucket. */
    presignGet(region: string, bucket: string, key: string, seconds: number, filename: string): Promise<string>;
}

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
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

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
    async sendDocument(region, id, document, parameters) {
        const sent = await ssmc(region).send(new SendCommandCommand({
            InstanceIds: [id], DocumentName: document, Parameters: parameters, TimeoutSeconds: 60, Comment: 'ops-console',
        }));
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
            if (inv?.status === 'failed') throw new Error(`SSM command ${inv.detail}: ${inv.stderr.slice(0, 200)}`);
            await sleep(1500);
        }
        throw new Error('SSM command timed out');
    },
};

let provider: AwsProvider = realAws;
export const aws = () => provider;
/** Tests: swap in a fake. */
export function setAwsProvider(p: AwsProvider): void {
    provider = p;
}
