import type {
  Lecture,
  RequestStatus,
  ResponsibilityKey,
  ScheduleConflict,
  UserAccount,
} from '../types.ts';

export const DAY_NAMES_AR: Record<number, string> = {
  0: 'السبت',
  1: 'الأحد',
  2: 'الإثنين',
  3: 'الثلاثاء',
  4: 'الأربعاء',
  5: 'الخميس',
};

export const REQUEST_STATUS_LABELS_AR: Record<RequestStatus, string> = {
  draft: 'مسودة',
  open_for_endorsement: 'مفتوح للتأييد',
  ready_for_submission: 'جاهز للرفع',
  submitted: 'تم رفعه للجهة المختصة',
  under_review: 'قيد الدراسة',
  approved: 'تمت الموافقة الرسمية',
  approved_with_modifications: 'مقبول بتعديل',
  rejected: 'تعذر التنفيذ',
  closed: 'مغلق',
};

/**
 * Checks whether a user has a specific administrative responsibility.
 */
export function hasPermission(
  user: Pick<UserAccount, 'role' | 'responsibilities' | 'isActive'>,
  permission: ResponsibilityKey
): boolean {
  if (!user.isActive) return false;
  if (user.role === 'representative') return true;
  if (user.role === 'student') return false;
  // Deputy and Coordinator only get explicitly delegated responsibilities
  return Array.isArray(user.responsibilities) && user.responsibilities.includes(permission);
}

/**
 * Converts "HH:MM" time string into minutes since midnight.
 */
export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length !== 2) return -1;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return -1;
  }
  return hours * 60 + minutes;
}

/**
 * Checks if two student groups overlap (e.g. 'ALL' overlaps with 'A' and 'B').
 */
export function doGroupsOverlap(groupA: string, groupB: string): boolean {
  const a = groupA.trim().toUpperCase();
  const b = groupB.trim().toUpperCase();
  if (a === 'ALL' || b === 'ALL' || a === 'عام' || b === 'عام') return true;
  return a === b;
}

/**
 * Detects time conflicts between active lectures on the same day.
 * Cancelled lectures are ignored.
 */
export function detectScheduleConflicts(lectures: Lecture[]): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const activeLectures = lectures.filter((l) => l.status !== 'cancelled');

  for (let i = 0; i < activeLectures.length; i++) {
    for (let j = i + 1; j < activeLectures.length; j++) {
      const a = activeLectures[i];
      const b = activeLectures[j];

      if (a.dayOfWeek !== b.dayOfWeek) continue;

      const startA = timeToMinutes(a.startTime);
      const endA = timeToMinutes(a.endTime);
      const startB = timeToMinutes(b.startTime);
      const endB = timeToMinutes(b.endTime);

      if (startA < 0 || endA < 0 || startB < 0 || endB < 0) continue;

      // Check time interval overlap: [startA, endA) intersects [startB, endB)
      if (startA < endB && startB < endA) {
        const dayName = DAY_NAMES_AR[a.dayOfWeek] || 'يوم دراسي';

        if (a.location.trim().toLowerCase() === b.location.trim().toLowerCase()) {
          conflicts.push({
            lectureAId: a.id,
            lectureBId: b.id,
            reason: 'location',
            descriptionAr: `تعارض في القاعة (${a.location}) يوم ${dayName} بين (${a.courseNameAr || a.courseId}) و (${b.courseNameAr || b.courseId}) من ${a.startTime} إلى ${a.endTime}`,
          });
        } else if (a.instructor.trim().toLowerCase() === b.instructor.trim().toLowerCase()) {
          conflicts.push({
            lectureAId: a.id,
            lectureBId: b.id,
            reason: 'instructor',
            descriptionAr: `تعارض للمدرس (${a.instructor}) يوم ${dayName} بين (${a.courseNameAr || a.courseId}) و (${b.courseNameAr || b.courseId})`,
          });
        } else if (doGroupsOverlap(a.targetGroup, b.targetGroup)) {
          conflicts.push({
            lectureAId: a.id,
            lectureBId: b.id,
            reason: 'group',
            descriptionAr: `تعارض زمني للمجموعة (${a.targetGroup === 'ALL' ? b.targetGroup : a.targetGroup}) يوم ${dayName} بين (${a.courseNameAr || a.courseId}) و (${b.courseNameAr || b.courseId})`,
          });
        }
      }
    }
  }

  return conflicts;
}

/**
 * Determines if editing a request requires resetting existing student endorsements.
 */
export function requiresEndorsementResetOnEdit(
  oldHash: string,
  newHash: string,
  currentEndorsementCount: number
): boolean {
  return currentEndorsementCount > 0 && oldHash !== newHash;
}

/**
 * Validates allowed state transitions for requests/complaints/suggestions.
 * Enforces that student endorsements never mark a request as 'approved' without
 * first passing through official submission ('submitted' or 'under_review').
 */
const ALLOWED_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  draft: ['open_for_endorsement', 'ready_for_submission', 'submitted', 'closed'],
  open_for_endorsement: ['ready_for_submission', 'draft', 'closed'],
  ready_for_submission: ['submitted', 'open_for_endorsement', 'closed'],
  submitted: ['under_review', 'approved', 'approved_with_modifications', 'rejected', 'closed'],
  under_review: ['approved', 'approved_with_modifications', 'rejected', 'closed'],
  approved: ['closed'],
  approved_with_modifications: ['closed'],
  rejected: ['closed', 'under_review'],
  closed: [],
};

export function validateRequestTransition(
  currentStatus: RequestStatus,
  nextStatus: RequestStatus,
  actorCanManageRequests: boolean
): { valid: boolean; errorAr?: string } {
  if (currentStatus === nextStatus) {
    return { valid: true };
  }
  if (!actorCanManageRequests) {
    return {
      valid: false,
      errorAr: 'ليس لديك صلاحية تغيير الحالة الإدارية للطلب.',
    };
  }
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    return {
      valid: false,
      errorAr: `لا يمكن الانتقال مباشرة من حالة "${REQUEST_STATUS_LABELS_AR[currentStatus]}" إلى "${REQUEST_STATUS_LABELS_AR[nextStatus]}". لا يُعتمد الطلب إدارياً بمجرد تصويت الطلاب دون رفعه رسمياً.`,
    };
  }
  return { valid: true };
}

/**
 * Checks whether a student can endorse or withdraw endorsement from a request.
 */
export function canModifyEndorsement(
  status: RequestStatus,
  isCollective: boolean
): { allowed: boolean; errorAr?: string } {
  if (!isCollective) {
    return { allowed: false, errorAr: 'هذا الطلب فردي وليس مفتوحاً للتأييد الجماعي.' };
  }
  if (status !== 'open_for_endorsement') {
    return {
      allowed: false,
      errorAr: 'فترة جمع التأييدات لهذا الطلب مغلقة حالياً ولا يمكن إضافة أو سحب التأييد.',
    };
  }
  return { allowed: true };
}
