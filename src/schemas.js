import { z } from 'zod';
import { PROVIDERS, DEFAULT_PROVIDERS, PROFILES } from './config.js';

export const providerSchema = z.enum(PROVIDERS);
export const idSchema = z.string().uuid();
const text = (max) => z.string().trim().min(1).max(max);
const evidenceId = text(80).regex(/^[A-Za-z0-9_-]+$/);
export const imageInputSchema = z.object({
  id: evidenceId,
  title: text(300).describe('View label, e.g. front orthographic or head close-up.'),
  path: text(2000).describe('Absolute local PNG/JPEG file path on the MCP server host. The actual bytes are snapshotted and attached to model requests.'),
}).strict();
const imageManifestSchema = z.object({
  id: evidenceId, title: text(300), original_path: text(2000),
  mime_type: z.enum(['image/png', 'image/jpeg']), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(1).max(4 * 1024 * 1024),
  width: z.number().int().min(1).max(8000), height: z.number().int().min(1).max(8000),
}).strict();
export const sourceSchema = z.object({
  id: text(80).regex(/^[A-Za-z0-9_-]+$/),
  title: text(300),
  reference: text(2000).describe('File path and lines, commit, conversation ID, or tool result reference; never automatically fetched.'),
  kind: z.enum(['conversation', 'file', 'github', 'mcp', 'note']),
  observed_at: z.string().datetime({ offset: true }),
  content: text(40000).describe('Selected evidence, with speculation and accepted decisions clearly distinguished.'),
}).strict();

const briefingShape = {
  project: text(300),
  question: text(6000).describe('The original user question, preserved verbatim apart from surrounding whitespace.'),
  clarified_question: text(6000).optional(),
  summary: text(20000),
  assumptions: z.array(text(2000)).max(30).default([]),
  missing_context: z.array(text(2000)).max(30).default([]),
  sources: z.array(sourceSchema).min(1).max(40),
};
const uniqueEvidenceIds = (value, ctx) => {
  const ids = [...value.sources, ...(value.images || [])].map(source => source.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Source and image IDs must be unique' });
  }
};
export const briefingSchema = z.object({ ...briefingShape,
  images: z.array(imageInputSchema).max(8).optional().describe('Attach actual screenshots for visual reviews; paths in sources alone do not attach images.'),
}).strict().superRefine(uniqueEvidenceIds);
export const storedBriefingSchema = z.object({ ...briefingShape,
  images: z.array(imageManifestSchema).max(8).optional(),
}).strict().superRefine(uniqueEvidenceIds);

export const consultationSchema = z.object({
  briefing_id: idSchema,
  profile: z.enum(PROFILES).optional().describe('quick = inexpensive test/review models; deep = stronger review models with higher cost and output allowance. Omission uses COUNCIL_DEFAULT_PROFILE (quick by default). Use the same explicit profile for preview and submission.'),
  providers: z.array(providerSchema).min(1).max(PROVIDERS.length).default(DEFAULT_PROVIDERS)
    .describe('Explicit council members, including optional meta (Muse Spark standard). Omission preserves the original four members: openai, claude, gemini, mistral. Include meta explicitly after configuring META_API_KEY.'),
  synthesizer: providerSchema.nullable().default(null).describe('Optional extra paid call. Null leaves synthesis to the host using returned independent reviews.'),
  dry_run: z.boolean().default(true).describe('True previews the exact shared briefing and call plan without contacting providers. Set false to submit paid API requests.'),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.providers).size !== value.providers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Providers must be unique' });
  }
});
