const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');

test('Issue #168 - German copy: generic masculine "Teilnehmer" replaced with gendergerecht "Teilnehmer*innen" or "Teilnehmende"', () => {
  const indexHtml = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
  const invitationsJs = fs.readFileSync(path.join(projectRoot, 'public/js/invitations.js'), 'utf8');

  // #185: the attendee caption is a group name (div + aria-labelledby), not a <label>.
  const attendeeCaption = indexHtml.match(/id="ev-attendees-caption">([^<]*)</);
  assert.ok(attendeeCaption, 'index.html should contain the attendee group caption');
  assert.ok(
    ['Teilnehmer*innen', 'Teilnehmende'].includes(attendeeCaption[1]),
    'index.html should contain gendergerecht label for attendees'
  );

  assert.ok(!invitationsJs.includes('<small>Teilnehmer:</small>'), 'invitations.js should not contain generic masculine "<small>Teilnehmer:</small>"');
  assert.ok(
    invitationsJs.includes('<small>Teilnehmer*innen:</small>') ||
    invitationsJs.includes('<small>Teilnehmende:</small>'),
    'invitations.js should contain gendergerecht label for attendees'
  );
});

test('Issue #168 - German copy: generic masculine "Organisator" replaced with gendergerecht "Organisator*in"', () => {
  const invitationsJs = fs.readFileSync(path.join(projectRoot, 'public/js/invitations.js'), 'utf8');
  assert.ok(!invitationsJs.includes('Organisator:'), 'invitations.js should not contain generic masculine "Organisator:"');
  assert.ok(invitationsJs.includes('Organisator*in:'), 'invitations.js should contain gendergerecht "Organisator*in:"');
});

test('Issue #168 - German copy: generic masculine "Stellvertreter" replaced with gendergerecht "Stellvertreter*innen" or "Stellvertretung"', () => {
  const delegatesJs = fs.readFileSync(path.join(projectRoot, 'public/js/delegates.js'), 'utf8');
  assert.ok(!delegatesJs.includes('Keine Stellvertreter eingerichtet.'), 'delegates.js should not contain generic masculine "Stellvertreter"');
  assert.ok(
    delegatesJs.includes('Keine Stellvertreter*innen eingerichtet.') ||
    delegatesJs.includes('Keine Stellvertretung eingerichtet.'),
    'delegates.js should contain gendergerecht phrasing'
  );
});

test('Issue #168 - German copy: generic masculine "mit anderen Benutzern teilen" replaced with gendergerecht phrasing in app.js', () => {
  const appJs = fs.readFileSync(path.join(projectRoot, 'public/js/app.js'), 'utf8');
  assert.ok(!appJs.includes('Mit anderen Benutzern teilen'), 'app.js should not contain generic masculine "Mit anderen Benutzern teilen"');
  assert.ok(!appJs.includes('nur mit Benutzern auf demselben CalDAV-Server'), 'app.js should not contain "nur mit Benutzern auf demselben CalDAV-Server"');
  assert.ok(!appJs.includes('placeholder="Benutzer suchen'), 'app.js should not contain placeholder="Benutzer suchen');
  assert.ok(!appJs.includes('Bitte wähle einen Benutzer'), 'app.js should not contain "Bitte wähle einen Benutzer"');
});
