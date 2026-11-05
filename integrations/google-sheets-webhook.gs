/* Google Apps Script Web App that receives this kit's lead webhook and appends
   one row per lead to the bound Google Sheet.

   Setup:
   1. Create (or open) a Google Sheet.
   2. Extensions > Apps Script. Delete the default code and paste this file.
   3. Project Settings (gear icon) > Script Properties > add a property named
      WEBHOOK_KEY with a long random value you make up. This is NOT your
      CRM_WEBHOOK_SECRET from .env — it's a separate shared secret, passed as
      a URL query parameter, because Apps Script web apps cannot read custom
      HTTP headers (so the X-KCCC-Signature header this server also supports
      can't be checked here).
   4. Deploy > New deployment > type "Web app".
      - Execute as: Me
      - Who has access: Anyone
      Click Deploy and copy the Web app URL.
   5. On your server (e.g. Vercel project > Settings > Environment Variables),
      set:
        CRM_WEBHOOK_URL = <the Web app URL>?key=<the same WEBHOOK_KEY value>
      Leave CRM_WEBHOOK_SECRET unset (it has no effect with this script).
      Redeploy the server so the new env var takes effect.
   6. Submit a test enquiry on the live site and confirm a row appears here,
      and that the lead's "crm" status is "sent" in /admin.
*/

function doPost(e) {
  try {
    var key = PropertiesService.getScriptProperties().getProperty('WEBHOOK_KEY');
    if (key && e.parameter.key !== key) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'bad key' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var body = JSON.parse(e.postData.contents);
    if (body.event !== 'lead.created' || !body.lead) {
      return ContentService.createTextOutput(JSON.stringify({ ok: true, ignored: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var lead = body.lead;
    var p = lead.profile || {}, c = lead.contact || {}, r = lead.results || {}, cs = lead.consent || {};
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Leads') ||
      SpreadsheetApp.getActiveSpreadsheet().insertSheet('Leads');

    var headers = ['Ref', 'Created', 'Status', 'Name', 'Phone', 'Topic', 'Wants to know',
      'College', 'Course', 'Year', 'District', 'Mindset', 'Suggested areas', 'Preferred pathway',
      'Area explored', 'AI summary', 'Concern tip', 'Full summary', 'Notice version', 'VID'];
    if (sheet.getLastRow() === 0) sheet.appendRow(headers);

    sheet.appendRow([
      lead.ref || '', lead.createdAt || '', lead.status || '', c.name || '', c.phone || '',
      c.topic || '', c.ask || '', p.college || '', p.course || '', p.year || '', p.district || '',
      p.mindset || '', (r.suggestedAreas || []).join(' · '), r.preferredPath || '', r.exploredArea || '',
      r.aiSummary || '', r.concernTip || '', lead.summary || '', cs.noticeVersion || '', lead.vid || ''
    ]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
