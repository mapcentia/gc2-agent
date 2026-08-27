import type { Labels, UiConfirm } from "./types.js";

export function ConfirmCard({
  confirm,
  labels,
  onDecide,
  onDecideAll,
}: {
  confirm: UiConfirm;
  labels: Labels;
  onDecide: (toolUseId: string, approved: boolean) => void;
  onDecideAll: (approved: boolean) => void;
}) {
  const writes = confirm.pending.filter((p) => p.requiresApproval);
  const reads = confirm.pending.filter((p) => !p.requiresApproval);
  const undecided = writes.filter((p) => confirm.decisions[p.id] === undefined);
  return (
    <div className="ca-confirm">
      <div className="ca-confirm-head">
        <div className="ca-confirm-title">{labels.confirmTitle}</div>
        {!confirm.resolved && undecided.length > 1 && (
          <div className="ca-confirm-actions">
            <button type="button" className="ca-btn ca-btn-approve" onClick={() => onDecideAll(true)}>
              {labels.approveAll}
            </button>
            <button type="button" className="ca-btn ca-btn-deny" onClick={() => onDecideAll(false)}>
              {labels.denyAll}
            </button>
          </div>
        )}
      </div>
      {writes.map((p) => {
        const decision = confirm.decisions[p.id];
        return (
          <div key={p.id} className="ca-confirm-item">
            <code className="ca-confirm-name">{p.name}</code>
            <pre className="ca-confirm-input">{JSON.stringify(p.input, null, 2)}</pre>
            {confirm.resolved || decision !== undefined ? (
              <span className={`ca-confirm-decided ${decision ? "ca-ok" : "ca-no"}`}>
                {decision ? labels.approve : labels.deny}
              </span>
            ) : (
              <div className="ca-confirm-actions">
                <button type="button" className="ca-btn ca-btn-approve" onClick={() => onDecide(p.id, true)}>
                  {labels.approve}
                </button>
                <button type="button" className="ca-btn ca-btn-deny" onClick={() => onDecide(p.id, false)}>
                  {labels.deny}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {reads.length > 0 && (
        <div className="ca-confirm-reads">
          {labels.autoNote} ({reads.map((r) => r.name).join(", ")})
        </div>
      )}
    </div>
  );
}
