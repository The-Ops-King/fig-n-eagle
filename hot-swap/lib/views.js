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

export function volunteerView(day, hours) {
  if (!hours.length) return messageView('Cover an open hour', 'Every remaining hour today is covered. 🎉');
  return {
    type: 'modal',
    callback_id: 'volunteer_submit',
    private_metadata: day,
    title: plain('Cover an open hour'),
    submit: plain('Take it'),
    close: plain('Cancel'),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: "The hour gets blocked on your GHL calendar so round robin won't book you, and you'll be tagged for any transfers." } },
      {
        type: 'input',
        block_id: 'hour',
        label: plain('Which hour?'),
        element: {
          type: 'static_select',
          action_id: 'value',
          options: hours.map((h) => ({ text: plain(`${hourLabel(h)} ET`), value: String(h) })),
        },
      },
    ],
  };
}
