import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Everything the console needs from AWS, behind an interface so tests can use a fake. */
export interface AwsProvider {
    describeInstance(region: string, id: string): Promise<Ec2Info | null>;
    ssmOnline(region: string, id: string): Promise<boolean>;
    /** Run one of the console's fixed SSM documents (no free-form commands) and return stdout. */
    runDocument(region: string, id: string, document: string, parameters?: Record<string, string[]>): Promise<string>;
}

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
    async runDocument(region, id, document, parameters) {
        const client = ssmc(region);
        const sent = await client.send(new SendCommandCommand({
            InstanceIds: [id], DocumentName: document, Parameters: parameters, TimeoutSeconds: 60,
            Comment: 'ops-console',
        }));
        const commandId = sent.Command?.CommandId;
        if (!commandId) throw new Error('SSM did not return a command id');
        const deadline = Date.now() + 45_000;
        await sleep(1200);
        while (Date.now() < deadline) {
            try {
                const inv = await client.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: id }));
                if (inv.Status === 'Success') return inv.StandardOutputContent ?? '';
                if (['Failed', 'Cancelled', 'TimedOut', 'Cancelling'].includes(inv.Status ?? '')) {
                    throw new Error(`SSM command ${inv.Status}: ${(inv.StandardErrorContent || '').slice(0, 200)}`);
                }
            } catch (err) {
                if ((err as { name?: string }).name !== 'InvocationDoesNotExist') throw err;   // not registered yet
            }
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
