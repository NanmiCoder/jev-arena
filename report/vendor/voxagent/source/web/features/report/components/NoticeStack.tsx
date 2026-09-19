import type { ReportNotice } from "../../../../contracts/index.ts";

interface NoticeStackProps {
  notices: ReportNotice[];
}

export function NoticeStack({ notices }: NoticeStackProps) {
  if (notices.length === 0) return null;

  return (
    <section className="notice-stack" aria-label="报告提醒">
      {notices.map((notice, index) => (
        <aside
          className={`notice notice--${notice.kind}`}
          key={`${notice.kind}-${index}`}
          role={notice.kind === "boundary" ? "note" : "alert"}
        >
          <strong>{notice.title}</strong>
          <p>{notice.text}</p>
        </aside>
      ))}
    </section>
  );
}
