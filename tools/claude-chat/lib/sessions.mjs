import fs from 'node:fs';
import path from 'node:path';

const ID = /^[0-9a-f-]{36}$/i;
const KEEP = 500;

// Remembers which session ids this tool created, so that listing and resuming
// never reach other Claude Code sessions in the same repository. The file lives
// in the ignored .qa-local/ folder; a read or write failure only means an older
// chat is not offered again (fails closed).
export function fileSessionStore(file) {
  let ids = null;
  const load = () => {
    if (ids) return ids;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      ids = Array.isArray(data?.sessions) ? data.sessions.filter(id => typeof id === 'string' && ID.test(id)) : [];
    } catch { ids = []; }
    return ids;
  };
  return {
    has: id => load().includes(id),
    add(id) {
      if (!ID.test(String(id)) || load().includes(id)) return;
      ids = [...ids, id].slice(-KEEP);
      try {
        fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({sessions: ids}), {mode: 0o600});
        fs.renameSync(temp, file);
      } catch {}
    },
  };
}