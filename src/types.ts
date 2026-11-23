export type UserRole = 'representative' | 'deputy' | 'coordinator' | 'student';

export type ResponsibilityKey =
  | 'lectures'
  | 'assignments'
  | 'files'
  | 'announcements'
  | 'requests'
  | 'students'
  | 'permissions'
  | 'backup';

export interface UserAccount {
  id: string;
  universityId: string;
  fullName: string;
  email: string;
  role: UserRole;
  groupName: string; // 'A' | 'B' | 'C' | 'عام'
  responsibilities: ResponsibilityKey[];
  isActive: boolean;
  mustChangePassword?: boolean;
  isDemo: boolean;
  createdAt: string;
}

export interface Course {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  instructor: string;
  creditHours: number;
  level: string;
  semester: string;
  isDemo: boolean;
}

export type LectureStatus = 'official' | 'proposed' | 'confirmed_temp' | 'cancelled';

export interface Lecture {
  id: string;
  courseId: string;
  courseNameAr?: string;
  courseNameEn?: string;
  courseCode?: string;
  dayOfWeek: number; // 0 = السبت, 1 = الأحد, 2 = الإثنين, 3 = الثلاثاء, 4 = الأربعاء, 5 = الخميس
  startTime: string; // "08:00"
  endTime: string;   // "10:00"
  location: string;
  instructor: string;
  targetGroup: string; // 'ALL' | 'A' | 'B'
  lectureType: 'lecture' | 'lab' | 'tutorial';
  status: LectureStatus;
  notes: string;
  specificDate?: string;
  createdBy: string;
  isDemo: boolean;
}

export interface ScheduleConflict {
  lectureAId: string;
  lectureBId: string;
  reason: 'location' | 'instructor' | 'group';
  descriptionAr: string;
}

export type AssignmentGeneralStatus = 'active' | 'extended' | 'completed' | 'cancelled';
export type SourceConfirmationStatus = 'confirmed_instructor' | 'confirmed_rep' | 'unconfirmed_student';
export type PersonalProgressStatus = 'not_started' | 'in_progress' | 'completed';

export interface Assignment {
  id: string;
  courseId: string;
  courseNameAr?: string;
  courseCode?: string;
  title: string;
  description: string;
  instructor: string;
  publishedAt: string;
  dueDate: string;
  targetGroup: string; // 'ALL' | 'A' | 'B'
  generalStatus: AssignmentGeneralStatus;
  confirmationStatus: SourceConfirmationStatus;
  sourceNote: string;
  attachmentName?: string;
  attachmentFileId?: string;
  attachmentUrl?: string;
  createdBy: string;
  creatorName?: string;
  personalStatus?: PersonalProgressStatus;
  isDemo: boolean;
}

export type AnnouncementCategory =
  | 'general'
  | 'lectures'
  | 'assignments'
  | 'exams'
  | 'administrative'
  | 'urgent';

export type AnnouncementPriority = 'normal' | 'important' | 'urgent';

export interface Announcement {
  id: string;
  title: string;
  content: string;
  category: AnnouncementCategory;
  priority: AnnouncementPriority;
  targetGroup: string; // 'ALL' | 'A' | 'B'
  isPinned: boolean;
  attachmentName?: string;
  attachmentUrl?: string;
  createdBy: string;
  publisherName?: string;
  createdAt: string;
  isRead?: boolean;
  isDemo: boolean;
}

export type RequestType = 'request' | 'complaint' | 'suggestion';

export type RequestStatus =
  | 'draft'
  | 'open_for_endorsement'
  | 'ready_for_submission'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'approved_with_modifications'
  | 'rejected'
  | 'closed';

export interface RequestHistoryEntry {
  id: string;
  requestId: string;
  actorId: string;
  actorName: string;
  action: string;
  oldStatus?: string;
  newStatus?: string;
  note: string;
  createdAt: string;
}

export interface EndorsementRecord {
  id: string;
  requestId: string;
  studentId: string;
  studentName?: string;
  universityId?: string;
  groupName?: string;
  requestVersionHash: string;
  createdAt: string;
}

export interface CohortRequest {
  id: string;
  referenceNumber: string;
  requestType: RequestType;
  isCollective: boolean;
  targetAuthority: string;
  subject: string;
  details: string;
  proposedSolution: string;
  attachmentName?: string;
  status: RequestStatus;
  createdBy: string;
  creatorName?: string;
  assignedTo?: string;
  assigneeName?: string;
  authorityResponse?: string;
  versionHash: string;
  createdAt: string;
  closedAt?: string;
  endorsementCount: number;
  userHasEndorsed: boolean;
  endorsements?: EndorsementRecord[];
  history?: RequestHistoryEntry[];
  isDemo: boolean;
}

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'new' | 'in_progress' | 'awaiting_review' | 'completed' | 'blocked';

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface CohortTask {
  id: string;
  title: string;
  description: string;
  assignedTo: string;
  assigneeName?: string;
  createdBy: string;
  creatorName?: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  createdAt: string;
  comments?: TaskComment[];
  isDemo: boolean;
}

export type LibraryCategory =
  | 'lectures'
  | 'summaries'
  | 'assignments'
  | 'references'
  | 'labs'
  | 'other';

export interface LibraryFile {
  id: string;
  courseId: string;
  courseNameAr?: string;
  courseCode?: string;
  level: string;
  category: LibraryCategory;
  title: string;
  description: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  targetGroup: string;
  uploadedBy: string;
  uploaderName?: string;
  createdAt: string;
  isDemo: boolean;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  linkTab: string;
  isRead: boolean;
  createdAt: string;
}
