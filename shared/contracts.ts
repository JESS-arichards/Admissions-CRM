import { z } from 'zod';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MAX_COUNT = 5;
export const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
} as const;
export interface EnquiryDocument {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy: 'parent' | 'staff';
}

export const STAGES = ['New', 'In progress', 'Awaiting parent', 'Visit arranged', 'Resolved', 'Closed'] as const;
export const KINDS = ['Enquiry', 'Visit request'] as const;
export const centralUserSchema = z.object({
  id: z.number().int().positive(),
  email: z.email(),
  displayName: z.string(),
  isActive: z.boolean(),
  sessionVersion: z.number().int().nonnegative(),
  roles: z.array(z.string()),
});
export type CentralUser = z.infer<typeof centralUserSchema>;
export const canAdminister = (user: CentralUser) =>
  user.roles.some((role) => role === 'Full Admin' || role === 'Admissions Admin');
export const canWork = (user: CentralUser) => canAdminister(user) || user.roles.includes('Admissions Contributor');

export const requestSchema = z.object({
  kind: z.enum(KINDS),
  parentName: z.string().trim().min(2).max(120),
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  phone: z.string().trim().max(40).default(''),
  yearGroup: z.string().trim().max(60).default(''),
  message: z.string().trim().min(10).max(4000),
  emailOptIn: z.boolean(),
  privacyAccepted: z.literal(true),
  website: z.string().max(0).default(''),
}).strict();
export type NewRequest = z.infer<typeof requestSchema>;
export const trackingSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();
export const updateSchema = z.object({
  revision: z.number().int().positive(),
  stage: z.enum(STAGES),
  publicMessage: z.string().trim().max(2000).default(''),
  internalNote: z.string().trim().max(4000).default(''),
  assignment: z.enum(['keep', 'me', 'unassigned']).default('keep'),
}).strict();
export type RequestUpdate = z.infer<typeof updateSchema>;
export const pageSchema = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(10).max(20000),
  published: z.boolean(),
  revision: z.number().int().positive(),
}).strict();
export const PAGE_SLUGS = ['welcome', 'admissions', 'visits', 'privacy'] as const;
export const pageSlugSchema = z.enum(PAGE_SLUGS);
export type Page = { slug: string; title: string; body: string; published: boolean; revision: number };
export type Stage = typeof STAGES[number];
export type Kind = typeof KINDS[number];
export interface TimelineEntry {
  id: number;
  stage: Stage;
  publicMessage: string;
  createdAt: string;
}
export interface Progress {
  kind: Kind;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  notifications: 'off' | 'pending' | 'verified';
  timeline: TimelineEntry[];
}
export interface RequestSummary {
  id: number;
  kind: Kind;
  parentName: string;
  email: string;
  yearGroup: string;
  stage: Stage;
  ownerId: number | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface StaffEvent extends TimelineEntry {
  internalNote: string;
  actorName: string;
}
export interface RequestDetail extends RequestSummary {
  phone: string;
  message: string;
  notifications: Progress['notifications'];
  events: StaffEvent[];
  emailQueue: { pending: number; failed: number };
}
export const brandSchema = z.object({
  organisationName: z.string(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  backgroundColor: z.string(),
  accentColor: z.string(),
  textColor: z.string(),
  logoUrl: z.string().nullable(),
  footerLogoUrl: z.string().nullable(),
  iconUrl: z.string().nullable(),
  backgroundUrl: z.string().nullable(),
  websiteUrl: z.string(),
  valuesTitle: z.string(),
  homeValues: z.string(),
});
export type Brand = z.infer<typeof brandSchema>;
export interface PublicConfig {
  entra: { clientId: string; authority: string; enabled: boolean };
  profileUrl: string;
  emailEnabled: boolean;
  documents?: { ready: boolean; maxBytes: number; maxCount: number };
}
