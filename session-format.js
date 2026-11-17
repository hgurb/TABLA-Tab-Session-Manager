// Local time with a fixed layout, independent of the browser's language.
export function sessionDate(at) {
  const date = new Date(at), pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sessionLabel(session) {
  // Display older automatically generated names in the same format.
  return session.name === new Date(session.at).toLocaleString() ? sessionDate(session.at) : session.name;
}
