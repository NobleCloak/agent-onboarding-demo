export function TicketCard({ from, time, text }: { from: string; time: string; text: string }) {
  return (
    <div className="tick">
      <div className="m">
        {from} · {time}
      </div>
      <div className="q">{text}</div>
    </div>
  );
}
