# Caption Delete Feature

## Overview

Added delete functionality to the transcript page that removes captions from:
- Transcript file (`captions.log`)
- In-memory caption history
- Audience viewer buffer
- All connected audience viewers (real-time)

---

## Features

### 1. **Delete Button on Transcript Page**

Each caption now has both edit and delete buttons:
- ✏️ **Edit** - Modify caption text
- 🗑️ **Delete** - Remove caption completely

### 2. **Confirmation Dialog**

Before deleting, user sees a confirmation with caption preview:
```
Are you sure you want to delete this caption?

"Hello and welcome to the service today..."
```

### 3. **Real-Time Sync**

When a caption is deleted:
1. Removed from `captions.log` file
2. Removed from server memory
3. Removed from audience buffer
4. **Broadcast to all audience viewers** (caption disappears from their screens)

### 4. **Smooth Animation**

Deleted captions fade out with a slide animation before removal.

---

## Implementation Details

### Server-Side (`ws-server.js`)

**New Endpoint:**
```javascript
POST /transcript/delete
Body: { timestamp: "2026-01-14T12:34:56.789Z" }
Response: { success: true, message: "Caption deleted successfully" }
```

**Delete Logic:**
1. Read `captions.log` file
2. Filter out caption with matching timestamp
3. Write updated content back to file
4. Remove from `captionHistory` array
5. Remove from `audienceCaptionBuffer`
6. Broadcast delete event to audience via SSE

**Broadcast Format:**
```json
{
  "type": "delete",
  "timestamp": "2026-01-14T12:34:56.789Z"
}
```

### Transcript Page (`/transcript`)

**HTML Changes:**
```html
<div class="caption-actions">
  <button class="edit-btn" onclick="editCaption(this)">✏️</button>
  <button class="delete-btn" onclick="deleteCaption(this)">🗑️</button>
</div>
```

**CSS:**
```css
.delete-btn {
  background: transparent;
  border: 1px solid transparent;
  color: #858585;
  opacity: 0; /* Hidden until hover */
}

.caption-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: #3e3e42;
  border-color: #f44336;
  color: #f44336;
}
```

**JavaScript:**
```javascript
function deleteCaption(button) {
  const captionItem = button.closest('.caption-item');
  const timestamp = captionItem.getAttribute('data-timestamp');
  
  // Confirm
  if (!confirm('Are you sure...')) return;
  
  // Send delete request
  fetch('/transcript/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp })
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      // Animate out
      captionItem.style.opacity = '0';
      captionItem.style.transform = 'translateX(-20px)';
      setTimeout(() => captionItem.remove(), 300);
    }
  });
}
```

### Audience Page (`audience.html`)

**Message Handling:**
```javascript
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'delete') {
    deleteCaption(data.timestamp);
  }
};

function deleteCaption(timestamp) {
  const index = captions.findIndex(c => c.timestamp === timestamp);
  if (index !== -1) {
    captions.splice(index, 1);
    renderCaptions(); // Re-render without deleted caption
  }
}
```

---

## User Experience

### For Admin (Transcript Page)

1. **Hover over caption** → Edit and delete buttons appear
2. **Click 🗑️ delete button**
3. **Confirmation dialog** shows caption preview
4. **Click "OK"** to confirm
5. **Caption fades out** and disappears
6. **Stats update** automatically

### For Audience (Audience Page)

1. Viewing captions on phone/tablet
2. Admin deletes a caption
3. **Caption instantly disappears** from their screen
4. No reload needed, seamless experience

---

## Use Cases

### 1. **Remove Duplicate Captions**
Sometimes Soniox sends duplicate translations. Delete the extra one.

### 2. **Remove Incorrect Translations**
If a translation is completely wrong and can't be fixed with editing, delete it.

### 3. **Remove Test Captions**
During pre-service testing, delete test captions before service starts.

### 4. **Remove Sensitive Information**
If something sensitive was accidentally transcribed, delete it immediately.

### 5. **Clean Up Transcript**
After service, clean up the transcript by removing noise, coughs, etc.

---

## Testing

### Test 1: Basic Delete
1. Open `/transcript` page
2. Hover over any caption
3. Click 🗑️ delete button
4. Confirm deletion
5. Caption should disappear
6. Refresh page → Caption still gone

### Test 2: Audience Sync
1. Open `/transcript` in one tab
2. Open audience page in another tab
3. Delete a caption from transcript
4. **Audience page should update immediately**

### Test 3: File Persistence
1. Delete a caption
2. Restart server
3. Open `/transcript` page
4. Deleted caption should not appear

### Test 4: Multiple Deletes
1. Delete multiple captions in quick succession
2. All should be removed
3. No errors in console

### Test 5: Cancel Deletion
1. Click delete button
2. Click "Cancel" in confirmation
3. Caption should remain

---

## Edge Cases Handled

### 1. **Caption Not Found**
If caption was already deleted or doesn't exist:
```json
{ "success": false, "error": "Caption not found" }
```

### 2. **File Write Error**
If file system error occurs:
```json
{ "success": false, "error": "Failed to save changes" }
```

### 3. **Concurrent Deletes**
Multiple admins deleting same caption:
- First delete succeeds
- Second delete gets "Caption not found" error

### 4. **Audience Not Connected**
If no audience viewers connected:
- Delete still works
- No broadcast needed

### 5. **Caption Not in Audience Buffer**
If deleted caption is old (not in last 6):
- Delete from file and memory
- No audience broadcast needed (they don't see it anyway)

---

## Security Considerations

### 1. **No Authentication**
Currently, anyone with access to `/transcript` can delete captions.

**Mitigation:**
- Use nginx IP whitelisting for admin subdomain
- Or add password protection (see `CRITICAL_FIXES_GUIDE.md`)

### 2. **No Undo**
Deleted captions are permanently removed from `captions.log`.

**Mitigation:**
- Confirmation dialog before delete
- Regular backups of `captions.log`

### 3. **Audit Trail**
Deletions are logged to `server.log`:
```
Caption deleted: "Hello and welcome" (2026-01-14T12:34:56.789Z)
```

---

## Backup & Recovery

### Backup Before Service
```bash
# Backup captions log
cp captions-app/captions.log captions-app/captions.backup.log
```

### Restore Deleted Captions
```bash
# If you accidentally deleted captions
cp captions-app/captions.backup.log captions-app/captions.log

# Restart server
docker-compose restart
```

### Automated Backup
```bash
# Add to cron (daily at 2 AM)
0 2 * * * cp /path/to/captions.log /path/to/backups/captions-$(date +\%Y\%m\%d).log
```

---

## Keyboard Shortcuts (Future Enhancement)

Potential keyboard shortcuts for faster editing:
- `E` - Edit caption
- `D` or `Delete` - Delete caption
- `Ctrl+Z` - Undo last delete (requires undo stack)

---

## API Reference

### Delete Caption

**Endpoint:** `POST /transcript/delete`

**Request:**
```json
{
  "timestamp": "2026-01-14T12:34:56.789Z"
}
```

**Success Response:**
```json
{
  "success": true,
  "message": "Caption deleted successfully"
}
```

**Error Responses:**
```json
// Missing timestamp
{
  "success": false,
  "error": "Missing timestamp"
}

// Caption not found
{
  "success": false,
  "error": "Caption not found"
}

// File system error
{
  "success": false,
  "error": "Failed to save changes"
}
```

---

## Related Features

- **Edit Caption:** Modify caption text (existing)
- **Export Transcript:** Download as TXT, CSV, JSON, SRT (existing)
- **Time Adjustment:** Adjust timestamps for SRT export (existing)
- **Live Editing:** Edits broadcast to audience (existing)

---

## Future Enhancements

### 1. **Bulk Delete**
- Select multiple captions
- Delete all at once

### 2. **Undo/Redo**
- Undo last delete
- Redo deleted caption

### 3. **Soft Delete**
- Mark as deleted instead of removing
- Can be restored later

### 4. **Delete History**
- Track all deletions
- Show who deleted what and when

### 5. **Keyboard Shortcuts**
- Faster workflow for power users

---

## Troubleshooting

### Issue: Delete button not visible

**Cause:** CSS not loaded or hover not working

**Fix:** Refresh page, check browser console for errors

### Issue: Delete doesn't work

**Cause:** Server endpoint not responding

**Check:**
```bash
# Test endpoint directly
curl -X POST http://localhost:8080/transcript/delete \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"2026-01-14T12:34:56.789Z"}'
```

### Issue: Caption deleted but still shows on audience page

**Cause:** SSE connection issue or caption not in buffer

**Check:**
1. Open browser console on audience page
2. Look for delete event in Network tab (EventStream)
3. Check if caption timestamp matches

### Issue: Confirmation dialog in wrong language

**Cause:** Browser language settings

**Fix:** Confirmation uses browser's native dialog (can't customize language easily)

---

**Version:** 1.0.0  
**Last Updated:** 2026-01-14  
**Status:** ✅ Implemented and Tested


