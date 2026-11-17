import { aws, dryRun } from './aws';
import { repoToken } from './github';

/**
 * A GitHub installation token scoped to one repository (contents: read, expires within the hour) is left in SSM at
 * /ops-console/git-tokens/<project> (SecureString, in the instance's region) just before a document runs, so the box
 * can clone/fetch over HTTPS. The box reads it into a 0600 file for GIT_ASKPASS; the console deletes the parameter
 * as soon as the run finishes. Never stored in the console database, never in command parameters.
 */
export const tokenParam = (project: string) => `/ops-console/git-tokens/${project}`;

export async function stashToken(region: string, project: string, repo: string): Promise<string | null> {
    const a = aws();
    if (dryRun || !a.putConsoleSecret) return null;
    const { token } = await repoToken(repo);
    const name = tokenParam(project);
    await a.putConsoleSecret(region, name, token);
    return name;
}

export async function dropToken(region: string, name: string | null | undefined): Promise<void> {
    if (!name || !name.startsWith('/ops-console/git-tokens/')) return;
    await aws().deleteConsoleSecret?.(region, name).catch((err) => console.error('could not delete token parameter:', (err as Error).message));
}
