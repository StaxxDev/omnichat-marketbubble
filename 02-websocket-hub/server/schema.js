'use strict';

// Shared unified message schema + source metadata.
// Every connector emits objects of this exact shape:
// { id, source, channel, author, text, color, ts }

const SOURCES = {
  twitch: { label: 'TWITCH', emoji: '🎮', color: '#9146FF' },
  x: { label: 'X', emoji: '𝕏', color: '#1D9BF0' },
  kick: { label: 'KICK', emoji: '⚡', color: '#53FC18' },
};

let counter = 0;
function uid(prefix) {
  counter = (counter + 1) % 1e9;
  return `${prefix || 'm'}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

// Normalize an emitted message: strip newlines, fill defaults, guarantee shape.
function makeMessage({ id, source, channel, author, text, color, ts }) {
  return {
    id: id || uid(source),
    source,
    channel: channel || '',
    author: author || 'anon',
    text: String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim(),
    color: color || '',
    ts: ts || Date.now(),
  };
}

module.exports = { SOURCES, uid, makeMessage };
