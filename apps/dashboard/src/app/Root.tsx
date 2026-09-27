import { Shell } from './Shell';
import { useRouter } from './router';
import { Landing } from '../pages/Landing';
import { Overview, RiskCenter, Wallets, Settings, AuditLog, Developers } from '../pages/system';
import { Agents, AgentDetail, Policies, PolicyDetail } from '../pages/catalog';
import { Transactions, TransactionDetail, Approvals } from '../pages/flow';
import { EmptyState, Button } from '../components/ui';
import { Link } from './router';

/**
 * The route table, read top to bottom.
 *
 * `/` is the public landing page and everything under `/app` is the control center. There
 * is no auth gate here on purpose: the screens are reading a sample tenant, and a fake
 * login would be the one thing that makes a demo look like a product that works when it
 * does not. When `api/client.ts` is swapped for the real fetch client, the credential goes
 * there and the gate becomes one check in `Shell`.
 */
export function Root() {
  const { path } = useRouter();

  if (path.length === 0) return <Landing />;

  const [head, second] = path as readonly string[];
  if (head !== 'app') {
    return (
      <Shell>
        <div className="mx-auto mt-16 max-w-md border border-line bg-panel">
          <EmptyState
            title="That page does not exist"
            body={`Nothing is routed at /${path.join('/')}. The control center lives under /app, and the public page is at /.`}
            action={<Link to="/app"><Button variant="primary">Open the control center</Button></Link>}
          />
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {second === undefined && <Overview />}
      {second === 'agents' && (third(path) === undefined ? <Agents /> : <AgentDetail name={third(path)!} />)}
      {second === 'policies' && (third(path) === undefined ? <Policies /> : <PolicyDetail keyName={third(path)!} />)}
      {second === 'transactions' && (third(path) === undefined ? <Transactions /> : <TransactionDetail id={third(path)!} />)}
      {second === 'approvals' && <Approvals />}
      {second === 'risk' && <RiskCenter />}
      {second === 'wallets' && <Wallets />}
      {second === 'audit' && <AuditLog />}
      {second === 'developers' && <Developers />}
      {second === 'settings' && <Settings />}
      {second !== undefined && !['agents', 'policies', 'transactions', 'approvals', 'risk', 'wallets', 'audit', 'developers', 'settings'].includes(second) && (
        <EmptyState title="No such screen" body="The route is not part of the control center." action={<Link to="/app"><Button>Back to overview</Button></Link>} />
      )}
    </Shell>
  );
}

const third = (path: readonly string[]): string | undefined => path[2];
