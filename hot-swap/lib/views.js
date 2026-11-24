import { formatTime, hourLabel } from './time.js';

const plain = (text) => ({ type: 'plain_text', text: text.slice(0, 75) });

export function loadingView(title) {
  return {
    type: 'modal',
    title: plain(title),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '_Loading…_' } }],
  };
}

export function messageView(title, text) {
  return {
    type: 'modal',
    title: plain(title),
    close: plain('Close'),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

export function requestView(cfg, appointments) {
  if (!appointments.length) {
    return messageView('Request a hot swap', "You don't have any appointments in the next 12 hours.");
  }
  return {
    type: 'modal',
    callback_id: 'request_submit',
    title: plain('Request a hot swap'),
    submit: plain('Post request'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'appt',
        label: plain('Which call do you need covered?'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: appointments.map((e) => ({
            text: plain(`${formatTime(Date.parse(e.startTime), cfg.timezone)} ET · ${e.title || 'Appointment'}${e.ownerName ? ` (${e.ownerName})` : ''}`),
            value: e.id,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'reason',
        optional: true,
        label: plain('Why (optional)'),
        element: { type: 'plain_text_input', action_id: 'value', placeholder: plain('e.g. current call running long') },
      },
    ],
  };
}

export function releaseView(day, slots) {
  if (!slots.length) return messageView("Can't make my hour", "You don't have any upcoming on-call hours today.");
  return {
    type: 'modal',
    callback_id: 'release_submit',
    private_metadata: day,
    title: plain("Can't make my hour"),
    submit: plain('Release it'),
    close: plain('Cancel'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: "I'll free the hour on your GHL calendar and hand it to the next free person." } },
      {
        type: 'input',
        block_id: 'slot',
        label: plain('Which hour?'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: slots.map((s) => ({ text: plain(`${hourLabel(s.hour)} ET`), value: String(s.id) })),
        },
      },
    ],
  };
}

// hours: [{ hour, count, need }] (only hours that still need cover)
export function volunteerView(day, hours) {
  if (!hours.length) return messageView('Cover an hour', 'Every remaining hour is covered. 🎉');
  return {
    type: 'modal',
    callback_id: 'volunteer_submit',
    private_metadata: day,
    title: plain('Cover an hour'),
    submit: plain('Take it'),
    close: plain('Cancel'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: "The hour goes on your GHL and Google calendar so round robin won't book you, and you'll be tagged for transfers." } },
      {
        type: 'input',
        block_id: 'hour',
        label: plain('Which hour?'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: hours.map((h) => ({
            text: plain(`${hourLabel(h.hour)} ET  ⚠️ needs ${h.need}`),
            value: String(h.hour),
          })),
        },
      },
    ],
  };
}

const hourOpt = (h) => ({ text: plain(hourLabel(h)), value: String(h) });

// upcoming: [{ day, label, source }]
export function datesView(upcoming, initialDay) {
  const lines = upcoming.map((u) => `${u.source === 'default' ? '' : '*'}${formatDayShort(u.day)}: ${u.label}${u.source === 'default' ? '' : '*'}${u.source === 'weekday' ? ' _(weekly)_' : ''}`);
  return {
    type: 'modal',
    callback_id: 'dates_submit',
    title: plain('Hot-swap coverage'),
    submit: plain('Save'),
    close: plain('Close'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Next 14 days* (ET, changes in bold)\n${lines.join('\n')}` } },
      { type: 'divider' },
      { type: 'input', block_id: 'day', label: plain('Date'), element: { type: 'datepicker', action_id: 'value', initial_date: initialDay } },
      {
        type: 'input', block_id: 'scope', label: plain('Apply to'),
        element: { type: 'radio_buttons', action_id: 'value', initial_option: { text: plain('This date only'), value: 'date' },
          options: [{ text: plain('This date only'), value: 'date' }, { text: plain('Every week on this weekday'), value: 'weekday' }] },
      },
      {
        type: 'input', block_id: 'mode', label: plain('Coverage'),
        element: { type: 'radio_buttons', action_id: 'value', initial_option: { text: plain('Off (no coverage)'), value: 'off' },
          options: [
            { text: plain('Off (no coverage)'), value: 'off' },
            { text: plain('Custom hours'), value: 'hours' },
            { text: plain('Normal (remove the exception)'), value: 'normal' },
          ] },
      },
      { type: 'input', block_id: 'from', optional: true, label: plain('From (custom hours)'),
        element: { type: 'static_select', action_id: 'value', options: Array.from({ length: 17 }, (_, i) => hourOpt(6 + i)) } },
      { type: 'input', block_id: 'until', optional: true, label: plain('Until (custom hours)'),
        element: { type: 'static_select', action_id: 'value', options: Array.from({ length: 17 }, (_, i) => hourOpt(7 + i)) } },
    ],
  };
}

function formatDayShort(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}
