/**
 * Minimal vector-based PDF generator for FreeShard WebCalendar.
 * Generates valid PDF-1.4 documents with structured vector graphics,
 * text elements, grid lines, and event boxes.
 */

function sanitizePdfText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

class PdfDocumentBuilder {
  constructor(pageWidth = 842, pageHeight = 595) {
    this.width = pageWidth;
    this.height = pageHeight;
    this.streamCommands = [];
  }

  setFont(fontName = 'F1', size = 12) {
    this.streamCommands.push(`BT /${fontName} ${size} Tf ET`);
  }

  setStrokeColor(r, g, b) {
    this.streamCommands.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
  }

  setFillColor(r, g, b) {
    this.streamCommands.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
  }

  setLineWidth(w) {
    this.streamCommands.push(`${w} w`);
  }

  drawLine(x1, y1, x2, y2) {
    this.streamCommands.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  drawRect(x, y, w, h, fill = false, stroke = true) {
    let mode = 'S';
    if (fill && stroke) mode = 'B';
    else if (fill) mode = 'f';
    this.streamCommands.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${mode}`);
  }

  drawText(text, x, y, fontName = 'F1', size = 10, r = 0, g = 0, b = 0) {
    const escaped = sanitizePdfText(text);
    this.streamCommands.push(
      `BT ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg /${fontName} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escaped}) Tj ET`
    );
  }

  toBuffer() {
    const streamContent = this.streamCommands.join('\n');
    const streamLength = Buffer.byteLength(streamContent, 'latin1');

    const objects = [];
    objects.push('%PDF-1.4\n');

    // 1 0 obj: Catalog
    const obj1 = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
    objects.push(obj1);

    // 2 0 obj: Pages
    const obj2 = `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`;
    objects.push(obj2);

    // 3 0 obj: Page
    const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`;
    objects.push(obj3);

    // 4 0 obj: Contents stream
    const obj4 = `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`;
    objects.push(obj4);

    // 5 0 obj: Font
    const obj5 = `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`;
    objects.push(obj5);

    // Calculate xref offset table
    let currentOffset = objects[0].length;
    const offsets = [0]; // object 0 offset

    for (let i = 1; i < objects.length; i++) {
      offsets.push(currentOffset);
      currentOffset += objects[i].length;
    }

    const startXref = currentOffset;

    let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i++) {
      const offStr = String(offsets[i]).padStart(10, '0');
      xref += `${offStr} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

    const fullPdfText = objects.join('') + xref + trailer;
    return Buffer.from(fullPdfText, 'latin1');
  }
}

function generateCalendarPDF(opts = {}) {
  const {
    view = 'month',
    year = new Date().getFullYear(),
    month = new Date().getMonth() + 1,
    week = 1,
    events = [],
    title,
    orientation = 'landscape'
  } = opts;

  const width = orientation === 'landscape' ? 842 : 595;
  const height = orientation === 'landscape' ? 595 : 842;
  const doc = new PdfDocumentBuilder(width, height);

  const documentTitle = title || (view === 'month' ? `Monatsansicht - ${month}/${year}` : `Wochenansicht - KW ${week} (${year})`);

  // Document Header Box
  doc.setFillColor(0.95, 0.96, 0.98);
  doc.drawRect(20, height - 60, width - 40, 40, true, false);

  doc.setStrokeColor(0.2, 0.3, 0.5);
  doc.setLineWidth(1.5);
  doc.drawLine(20, height - 60, width - 20, height - 60);

  doc.drawText(documentTitle, 30, height - 42, 'F1', 16, 0.1, 0.2, 0.4);
  doc.drawText(`FreeShard WebCalendar Vector PDF Engine | Exported ${new Date().toISOString().slice(0, 10)}`, width - 360, height - 40, 'F1', 8, 0.5, 0.5, 0.5);

  if (view === 'month') {
    renderMonthGrid(doc, width, height, year, month, events);
  } else {
    renderWeekGrid(doc, width, height, year, week, events);
  }

  return doc.toBuffer();
}

function renderMonthGrid(doc, width, height, year, month, events) {
  const startX = 20;
  const startY = height - 80;
  const gridWidth = width - 40;
  const gridHeight = height - 100;

  const colWidth = gridWidth / 7;
  const weekDays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Render Weekday Header
  doc.setFillColor(0.9, 0.92, 0.95);
  doc.drawRect(startX, startY - 20, gridWidth, 20, true, true);

  weekDays.forEach((day, idx) => {
    const x = startX + idx * colWidth;
    doc.drawText(day, x + colWidth / 2 - 8, startY - 14, 'F1', 10, 0.2, 0.3, 0.5);
  });

  // Calculate days in month & starting day of week
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  let startDayOfWeek = firstDay.getUTCDay() - 1; // 0 = Mon, 6 = Sun
  if (startDayOfWeek < 0) startDayOfWeek = 6;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const numRows = Math.ceil((startDayOfWeek + daysInMonth) / 7);
  const rowHeight = (gridHeight - 20) / numRows;

  // Draw Grid Lines
  doc.setStrokeColor(0.8, 0.8, 0.8);
  doc.setLineWidth(0.5);

  let currentDay = 1;
  for (let row = 0; row < numRows; row++) {
    const rowY = startY - 20 - (row + 1) * rowHeight;
    for (let col = 0; col < 7; col++) {
      const cellX = startX + col * colWidth;
      const cellY = startY - 20 - row * rowHeight;

      doc.drawRect(cellX, cellY - rowHeight, colWidth, rowHeight, false, true);

      const cellDayIdx = row * 7 + col;
      if (cellDayIdx >= startDayOfWeek && currentDay <= daysInMonth) {
        // Draw day number
        doc.drawText(String(currentDay), cellX + colWidth - 18, cellY - 14, 'F1', 9, 0.3, 0.3, 0.3);

        // Find events for this day
        const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
        const dayEvents = events.filter((ev) => {
          const evDate = (ev.dtstart || ev.start_time || '').slice(0, 10);
          return evDate === dayStr;
        });

        let eventY = cellY - 28;
        dayEvents.slice(0, 4).forEach((ev) => {
          if (eventY - 14 >= cellY - rowHeight) {
            doc.setFillColor(0.85, 0.92, 1.0);
            doc.setStrokeColor(0.2, 0.5, 0.8);
            doc.drawRect(cellX + 2, eventY - 12, colWidth - 4, 13, true, true);
            const title = (ev.summary || ev.title || 'Event').slice(0, 40);
            doc.drawText(title, cellX + 5, eventY - 9, 'F1', 8, 0.1, 0.2, 0.5);
            eventY -= 15;
          }
        });


        currentDay++;
      }
    }
  }
}

function renderWeekGrid(doc, width, height, year, week, events) {
  const startX = 50;
  const startY = height - 80;
  const gridWidth = width - 70;
  const gridHeight = height - 100;

  const colWidth = gridWidth / 7;
  const weekDays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

  // Header Row
  doc.setFillColor(0.9, 0.92, 0.95);
  doc.drawRect(startX - 30, startY - 20, gridWidth + 30, 20, true, true);

  weekDays.forEach((day, idx) => {
    const x = startX + idx * colWidth;
    doc.drawText(day, x + colWidth / 2 - 8, startY - 14, 'F1', 10, 0.2, 0.3, 0.5);
  });

  // Hours rows 08:00 - 18:00 (10 hours)
  const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const rowHeight = (gridHeight - 20) / (hours.length - 1);

  hours.forEach((h, idx) => {
    const y = startY - 20 - idx * rowHeight;
    doc.drawText(`${String(h).padStart(2, '0')}:00`, startX - 35, y - 4, 'F1', 8, 0.4, 0.4, 0.4);

    doc.setStrokeColor(0.85, 0.85, 0.85);
    doc.setLineWidth(0.5);
    doc.drawLine(startX, y, startX + gridWidth, y);
  });

  // Vertical Day Lines
  for (let col = 0; col <= 7; col++) {
    const x = startX + col * colWidth;
    doc.setStrokeColor(0.8, 0.8, 0.8);
    doc.setLineWidth(0.5);
    doc.drawLine(x, startY - 20, x, startY - 20 - (hours.length - 1) * rowHeight);
  }

  // Draw week events if any match
  events.forEach((ev) => {
    const dt = new Date(ev.dtstart || ev.start_time || Date.now());
    let dayOfWeek = dt.getUTCDay() - 1;
    if (dayOfWeek < 0) dayOfWeek = 6;

    const hour = dt.getUTCHours() + dt.getUTCMinutes() / 60;
    if (hour >= 8 && hour <= 18 && dayOfWeek >= 0 && dayOfWeek < 7) {
      const eventX = startX + dayOfWeek * colWidth + 2;
      const startHourOffset = hour - 8;
      const eventY = startY - 20 - startHourOffset * rowHeight;
      const durationHours = 1;
      const boxHeight = Math.max(15, durationHours * rowHeight);

      doc.setFillColor(0.85, 0.92, 1.0);
      doc.setStrokeColor(0.2, 0.5, 0.8);
      doc.drawRect(eventX, eventY - boxHeight, colWidth - 4, boxHeight, true, true);

      const title = (ev.summary || ev.title || 'Event').slice(0, 40);
      doc.drawText(title, eventX + 3, eventY - 12, 'F1', 8, 0.1, 0.2, 0.5);

    }
  });
}

module.exports = {
  generateCalendarPDF,
  sanitizePdfText
};
