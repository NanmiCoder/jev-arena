interface ReportFooterProps {
  note: string;
}

export function ReportFooter({ note }: ReportFooterProps) {
  return (
    <footer className="report-footer">
      <span>VoxAgent</span>
      <p>{note}</p>
    </footer>
  );
}
