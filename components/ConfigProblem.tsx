/** Shown instead of the sign-in controls when deployment mode is on but its settings are missing or wrong. */
export function ConfigProblem({ problems }: { problems: readonly string[] }) {
  return (
    <section role="alert" className="note" data-testid="deployment-config-problem">
      <b>Deployment mode is not configured</b>
      <p>
        Copy the deployment block of <code>.env.example</code> to <code>.env.local</code>, fill it in and restart (see docs/deployment-mode.md):
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </section>
  );
}
