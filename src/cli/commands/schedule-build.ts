import { ScheduleService } from '../../domain/schedule/schedule-service.js';
import { type SchedulingRules } from '../../domain/schedule/scheduler.js';
import { DrizzleScheduleUnitOfWork } from '../../persistence/schedule-unit-of-work.js';
import { ScheduleRepository } from '../../persistence/repositories/schedule.repo.js';
import { type CliContext } from '../context.js';

export function schedulingRules(c: CliContext['config']): SchedulingRules {
  return {
    windowStartHour: c.SCHEDULING_WINDOW_START_HOUR,
    windowEndHour: c.SCHEDULING_WINDOW_END_HOUR,
    allowedWeekdays: c.SCHEDULING_ALLOWED_WEEKDAYS.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
    minSpacingMinutes: c.SCHEDULING_MIN_SPACING_MINUTES,
    dailyCap: c.SCHEDULING_DAILY_CAP,
    earliestOffsetMinutes: c.SCHEDULING_EARLIEST_OFFSET_MINUTES,
    horizonDays: c.SCHEDULING_HORIZON_DAYS,
  };
}

/** Build the scheduling service (local + DB only; never sends, never calls Gmail). */
export function buildScheduleService(ctx: CliContext): ScheduleService {
  const c = ctx.config;
  return new ScheduleService({
    store: new ScheduleRepository(ctx.db),
    uow: new DrizzleScheduleUnitOfWork(ctx.db),
    logger: ctx.logger,
    config: { featureEnabled: c.SCHEDULING_ENABLED, rules: schedulingRules(c), rulesVersion: c.SCHEDULING_RULES_VERSION },
  });
}
