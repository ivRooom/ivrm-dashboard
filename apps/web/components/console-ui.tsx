import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

export type ConsoleTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "maintenance";

type ClassNameProp = {
  className?: string;
};

function classes(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function PageContent({
  children,
  className,
}: ClassNameProp & { children: ReactNode }) {
  return <section className={classes(styles.pageContent, className)}>{children}</section>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: ClassNameProp & {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={classes(styles.pageHeader, className)}>
      <div className={styles.headerCopy}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  aside,
  className,
}: ClassNameProp & {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className={classes(styles.sectionHeader, className)}>
      <div className={styles.sectionCopy}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h2>{title}</h2>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {aside ? <div className={styles.sectionAside}>{aside}</div> : null}
    </div>
  );
}

export function MetricGrid({
  children,
  className,
  label,
}: ClassNameProp & { children: ReactNode; label?: string }) {
  return (
    <section
      aria-label={label}
      className={classes(styles.metricGrid, className)}
    >
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
  className,
}: ClassNameProp & {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Exclude<ConsoleTone, "maintenance">;
}) {
  return (
    <article className={classes(styles.metricCard, className)} data-tone={tone}>
      <span className={styles.metricLabel}>{label}</span>
      <strong className={styles.metricValue}>{value}</strong>
      {detail ? <small className={styles.metricDetail}>{detail}</small> : null}
    </article>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: ClassNameProp & {
  children: ReactNode;
  tone?: ConsoleTone;
}) {
  return (
    <span className={classes(styles.statusBadge, className)} data-tone={tone}>
      {children}
    </span>
  );
}

export function ActionLink({
  href,
  children,
  variant = "secondary",
  className,
}: ClassNameProp & {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <a
      className={classes(styles.actionLink, className)}
      data-variant={variant}
      href={href}
    >
      {children}
    </a>
  );
}

export function StatePanel({
  title,
  children,
  variant = "empty",
  className,
}: ClassNameProp & {
  title: ReactNode;
  children?: ReactNode;
  variant?: "empty" | "error" | "warning" | "info";
}) {
  return (
    <div
      className={classes(styles.statePanel, className)}
      data-variant={variant}
      role={variant === "error" ? "alert" : undefined}
    >
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function TableShell({
  children,
  className,
  label,
}: ClassNameProp & { children: ReactNode; label?: string }) {
  return (
    <div
      aria-label={label}
      className={classes(styles.tableShell, className)}
      role={label ? "region" : undefined}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}
