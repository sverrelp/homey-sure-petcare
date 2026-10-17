import { SureSnapshot } from './types';

export interface LatestIntake {
  petName: string;
  at: string;
}

/**
 * Who last ate from a feeder or drank from a fountain, according to the pet records.
 * Sure Petcare tells which device registered the intake; when it does not, the intake is only
 * attributed if there is a single device of that kind.
 */
export function latestIntake(snapshot: SureSnapshot, kind: 'food' | 'water', deviceId: number): LatestIntake | null {
  const deviceCount = kind === 'food' ? snapshot.feeders.length : snapshot.felaquas.length;
  let latest: LatestIntake | null = null;

  for (const pet of snapshot.pets) {
    const intake = kind === 'food' ? pet.lastFeeding : pet.lastDrinking;
    if (!intake) {
      continue;
    }

    const matches = intake.deviceId === deviceId || (intake.deviceId === null && deviceCount === 1);
    if (matches && (!latest || new Date(intake.at) > new Date(latest.at))) {
      latest = { petName: pet.name, at: intake.at };
    }
  }

  return latest;
}
