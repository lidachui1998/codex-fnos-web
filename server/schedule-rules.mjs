function parseTime(value) {
  const match = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw Object.assign(new Error("执行时间必须是 HH:mm"), { status: 400 });
  return { hour: Number(match[1]), minute: Number(match[2]), value: match[0] };
}

export function normalizeSchedule(input) {
  const type = String(input?.type || "");
  if (type === "interval") {
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10_080) {
      throw Object.assign(new Error("间隔时间必须是 5 到 10080 分钟"), { status: 400 });
    }
    return { type, minutes };
  }
  const time = parseTime(input?.time).value;
  if (type === "daily") return { type, time };
  if (type === "weekly") {
    const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    if (days.length === 0) throw Object.assign(new Error("每周任务至少选择一天"), { status: 400 });
    return { type, time, days };
  }
  throw Object.assign(new Error("定时类型无效"), { status: 400 });
}

export function computeNextRun(scheduleInput, from = new Date()) {
  const schedule = normalizeSchedule(scheduleInput);
  if (schedule.type === "interval") return Math.floor((from.getTime() + schedule.minutes * 60_000) / 1000);
  const { hour, minute } = parseTime(schedule.time);
  if (schedule.type === "daily") {
    const candidate = new Date(from);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return Math.floor(candidate.getTime() / 1000);
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (schedule.days.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) {
      return Math.floor(candidate.getTime() / 1000);
    }
  }
  throw new Error("无法计算下一次执行时间");
}
