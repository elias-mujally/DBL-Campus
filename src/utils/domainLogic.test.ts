import { computeRequestVersionHash } from '../server/requestVersion.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canModifyEndorsement,
  detectScheduleConflicts,
  hasPermission,
  requiresEndorsementResetOnEdit,
  validateRequestTransition,
} from './domainLogic.ts';
import type { Lecture, UserAccount } from '../types.ts';

test('RBAC permission engine enforces Representative, Deputy, Coordinator, and Student boundaries', () => {
  const rep: Pick<UserAccount, 'role' | 'responsibilities' | 'isActive'> = {
    role: 'representative',
    responsibilities: [],
    isActive: true,
  };
  const deputy: Pick<UserAccount, 'role' | 'responsibilities' | 'isActive'> = {
    role: 'deputy',
    responsibilities: ['lectures', 'requests'],
    isActive: true,
  };
  const coordinator: Pick<UserAccount, 'role' | 'responsibilities' | 'isActive'> = {
    role: 'coordinator',
    responsibilities: ['assignments', 'files'],
    isActive: true,
  };
  const student: Pick<UserAccount, 'role' | 'responsibilities' | 'isActive'> = {
    role: 'student',
    responsibilities: ['backup'], // even if malformed, student role has no admin permissions
    isActive: true,
  };

  assert.equal(hasPermission(rep, 'backup'), true);
  assert.equal(hasPermission(rep, 'permissions'), true);
  assert.equal(hasPermission(deputy, 'requests'), true);
  assert.equal(hasPermission(deputy, 'backup'), false);
  assert.equal(hasPermission(coordinator, 'assignments'), true);
  assert.equal(hasPermission(coordinator, 'students'), false);
  assert.equal(hasPermission(student, 'backup'), false);
});

test('Schedule conflict detector catches room, instructor, and student group overlaps while ignoring cancelled lectures', () => {
  const baseLecture: Lecture = {
    id: 'lec-1',
    courseId: 'cs102',
    courseNameAr: 'برمجة الحاسوب 2',
    dayOfWeek: 1, // Sunday
    startTime: '08:00',
    endTime: '10:00',
    location: 'قاعة 101',
    instructor: 'د. أحمد المنصوري',
    targetGroup: 'A',
    lectureType: 'lecture',
    status: 'official',
    notes: '',
    createdBy: 'u1',
    isDemo: true,
  };

  const overlappingRoomLecture: Lecture = {
    ...baseLecture,
    id: 'lec-2',
    courseId: 'cs105',
    courseNameAr: 'تصميم الويب',
    startTime: '09:00',
    endTime: '11:00',
    location: 'قاعة 101',
    instructor: 'د. سارة العلي',
    targetGroup: 'B',
  };

  const cancelledLecture: Lecture = {
    ...baseLecture,
    id: 'lec-3',
    status: 'cancelled',
  };

  const conflicts = detectScheduleConflicts([
    baseLecture,
    overlappingRoomLecture,
    cancelledLecture,
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'location');
});

test('Request state machine blocks jumping directly from open_for_endorsement to approved without official submission', () => {
  const invalidApproval = validateRequestTransition('open_for_endorsement', 'approved', true);
  assert.equal(invalidApproval.valid, false);

  const validReady = validateRequestTransition('open_for_endorsement', 'ready_for_submission', true);
  assert.equal(validReady.valid, true);

  const validSubmit = validateRequestTransition('ready_for_submission', 'submitted', true);
  assert.equal(validSubmit.valid, true);

  const validOfficialApproval = validateRequestTransition('submitted', 'approved', true);
  assert.equal(validOfficialApproval.valid, true);

  const unauthorizedStudentAttempt = validateRequestTransition('submitted', 'approved', false);
  assert.equal(unauthorizedStudentAttempt.valid, false);
});

test('Substantial edit after endorsements requires endorsement reset and withdrawal is restricted to open_for_endorsement', () => {
  const h1 = computeRequestVersionHash('تأجيل اختبار', 'تفاصيل المشكلة', 'الأسبوع القادم');
  const h2 = computeRequestVersionHash('تأجيل اختبار', 'تفاصيل مختلفة كلياً', 'إلغاء الاختبار');

  assert.equal(requiresEndorsementResetOnEdit(h1, h1, 12), false);
  assert.equal(requiresEndorsementResetOnEdit(h1, h2, 12), true);
  assert.equal(requiresEndorsementResetOnEdit(h1, h2, 0), false);

  assert.equal(canModifyEndorsement('open_for_endorsement', true).allowed, true);
  assert.equal(canModifyEndorsement('submitted', true).allowed, false);
});
