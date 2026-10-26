import type { Commitment, CommitmentCheck, Review } from './types';
import { formatInr } from './format';

/** Compares this period's cost of a committed habit with the period it was committed in. */
export function checkCommitment(commitment: Commitment, review: Review): CommitmentCheck {
  const habit = review.habits.find((h) => h.key === commitment.key);
  const currentCost = habit?.cost ?? 0;
  const before = commitment.baselineCost;
  const period = review.summary.periodLabel;
  let status: CommitmentCheck['status'];
  let text: string;
  if (!habit) {
    status = 'gone';
    text = `Last time you committed to "${commitment.rule}" (it cost ${formatInr(before)} in ${commitment.baselinePeriod}). In ${period} it no longer shows up as a costly habit.`;
  } else if (currentCost <= before * 0.8) {
    status = 'improved';
    text = `"${commitment.title}" cost ${formatInr(currentCost)} in ${period}, down from ${formatInr(before)} in ${commitment.baselinePeriod}. Keep the rule going.`;
  } else if (currentCost >= before * 1.2) {
    status = 'worse';
    text = `"${commitment.title}" cost ${formatInr(currentCost)} in ${period}, up from ${formatInr(before)} in ${commitment.baselinePeriod}. The rule isn't sticking yet.`;
  } else {
    status = 'same';
    text = `"${commitment.title}" cost ${formatInr(currentCost)} in ${period}, about the same as ${formatInr(before)} in ${commitment.baselinePeriod}.`;
  }
  return { commitment, status, currentCost, text };
}
