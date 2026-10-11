import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="panel-content">{children}</div>
    </section>
  );
}
export function Status({ value }: { value?: string }) {
  const good = ["up", "active", "Running", "True", "success", "ready"].includes(
    value || "",
  );
  const bad = ["down", "error", "Failed", "False", "not_responding"].includes(
    value || "",
  );
  return (
    <span className={`status ${good ? "good" : bad ? "bad" : "neutral"}`}>
      <span aria-hidden="true" className="status-dot" />
      {value || "정보 없음"}
    </span>
  );
}
export function Details({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "")
    return <span className="muted">—</span>;
  if (Array.isArray(value))
    return value.length ? (
      <div className="detail-array">
        {value.map((v, i) => (
          <div key={i}>
            <Details value={v} />
          </div>
        ))}
      </div>
    ) : (
      <span className="muted">없음</span>
    );
  if (typeof value === "object" && Object.keys(value).length === 0)
    return <span className="muted">없음</span>;
  if (typeof value === "object")
    return (
      <dl className="property-grid">
        {Object.entries(value).map(([key, v]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>
              <Details value={v} />
            </dd>
          </React.Fragment>
        ))}
      </dl>
    );
  return (
    <span>
      {typeof value === "boolean" ? (value ? "예" : "아니요") : String(value)}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="panel-heading">
        <h2>{title}</h2>
        <button aria-label="닫기" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      <footer>
        <button className="primary" onClick={onClose}>
          닫기
        </button>
      </footer>
    </dialog>
  );
}
