import { createHash } from 'node:crypto';

export function computeRequestVersionHash(subject: string, details: string, proposedSolution: string, authority = ''): string {
  const fields = [subject, details, proposedSolution, authority].map(value => value.trim().replace(/\s+/g, ' '));
  return 'v2-' + createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
