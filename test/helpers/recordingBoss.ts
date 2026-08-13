import type { BossJobData, JobQueue } from "../../src/agentWork/intake/queueing.js";

export type RecordedBossJob = {
  readonly queue: string;
  readonly data: BossJobData;
  readonly options?: Parameters<JobQueue["send"]>[2];
};

export function createRecordingBoss(sent: RecordedBossJob[]): JobQueue {
  return {
    async send(queue, data, options) {
      sent.push({ queue, data, options });
      return "job-1";
    },
    async findJobs() {
      return [];
    },
    async deleteJob() {
      return {};
    },
    async cancel() {
      return {};
    },
  };
}

export function createJobQueue(
  overrides: Partial<JobQueue> = {},
  sent: RecordedBossJob[] = [],
): JobQueue {
  return {
    ...createRecordingBoss(sent),
    ...overrides,
  };
}
