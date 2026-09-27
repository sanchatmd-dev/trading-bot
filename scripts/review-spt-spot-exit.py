"""Run the frozen, offline Spot EXIT development comparison; never optimize."""

import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from pathlib import Path

from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.ql3a import mark_period
from robot_quant.spt_custom_evaluator import CustomOptimizationPlan
from robot_quant.spt_custom_evaluator import evaluate_bars as legacy_bars
from robot_quant.spt_spot_exit_v1 import evaluate_bars as revised_bars


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize_fills(fills, raw_bars, split):
    by_time = {row['time']: row for row in raw_bars}
    entries, closed, episodes, active = {}, [], [], []
    quantity = Decimal(0)
    for fill in fills:
        q = Decimal(fill['quantity'])
        if fill['event_type'] == 'BUY':
            entries[fill['entry_ref']] = fill
            quantity += q
            continue
        entry = entries.pop(fill['entry_ref'])
        quantity -= q
        raw = q * (Decimal(str(by_time[fill['time']]['close'])) - Decimal(str(by_time[entry['time']]['close'])))
        gross = q * (Decimal(fill['price']) - Decimal(entry['price']))
        fees = Decimal(entry['fee']) + Decimal(fill['fee'])
        trade = {'entry_time': entry['time'], 'exit_time': fill['time'], 'net': gross - fees,
                 'raw': raw, 'fees': fees, 'slippage': raw - gross, 'reason': fill['reason']}
        active.append(trade)
        closed.append(trade)
        if quantity == 0:
            episodes.append({'entry_time': min(t['entry_time'] for t in active), 'exit_time': fill['time'],
                             'allocations': len(active), 'net_pnl': str(sum(t['net'] for t in active))})
            active = []
    periods = {}
    for name, start, end in [('train', split['warmup'], split['train_end']),
                             ('validation', split['train_end'], split['validation_end'])]:
        low, high = raw_bars[start]['time'], raw_bars[end - 1]['time']
        trades = [t for t in closed if low <= t['exit_time'] <= high]
        completed = [e for e in episodes if low <= e['exit_time'] <= high]
        periods[name] = {
            'closed_allocations': len(trades), 'flat_to_flat_episodes': len(completed),
            'winning_episodes': sum(Decimal(e['net_pnl']) > 0 for e in completed),
            'closed_allocation_costs': {k: str(sum((t[k] for t in trades), Decimal(0)))
                                        for k in ['raw', 'fees', 'slippage', 'net']},
        }
    return {'periods': periods, 'episodes': episodes,
            'exit_fill_reasons': dict(Counter(t['reason'] for t in closed))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request', type=Path)
    parser.add_argument('plan', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = json.loads(args.request.read_text(encoding='utf-8'))
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    assert plan['version'] == 'spt-spot-exit-v1-development-plan'
    assert digest(args.request) == plan['baseline_request_file_sha256']
    assert digest(Path('quant_lab/src/robot_quant/spt_spot_exit_v1.py')) == plan['evaluator_sha256']
    assert plan['parameter_search_budget'] == 0 and plan['maximum_replays'] == 4
    c = data['request']['contract']
    split, rows, parameters = c['split'], c['dataset']['bars'], c['input_lock']['baseline']
    assert split == plan['split']
    assert len(rows) == split['validation_end'] < split['test_end']
    assert all(b['time'] - a['time'] == 60000 for a, b in zip(rows, rows[1:], strict=False))
    inputs = CustomOptimizationPlan.from_snapshot(c['source'].encode(), c['snapshot'])
    inputs = inputs.candidate({k: v for k, v in parameters.items() if k in inputs.domains})
    cash = Decimal(c['capital']['cash'])
    signal_sets = {'legacy': legacy_bars(rows, inputs), 'spot_exit_v1': revised_bars(rows, inputs)}
    results = []
    with localcontext() as ctx:
        ctx.prec = 50
        for factor in (1, 2):
            for version, evaluated in signal_sets.items():
                bars = [(BridgeBar(row['time'], *(Decimal(str(row[k])) for k in
                         ['open', 'high', 'low', 'close', 'volume']), Decimal(str(row['atr14']))),
                         signal.buy, signal.native_exit) for row, signal in zip(rows, evaluated, strict=True)]
                raw_model = c['model']
                model = PaperModel(**{k: Decimal(str(raw_model[k])) * (factor if k in ['fee_bps', 'slippage_bps'] else 1)
                                     for k in ['price_tick', 'quantity_step', 'fee_bps', 'slippage_bps', 'risk_percent']},
                                   version=raw_model['version'])
                replay = paper_replay(bars, deployment_id=c['deployment_id'],
                    multiplier=Decimal(str(parameters['atr_multiplier'])), rr=Decimal(str(parameters['rr'])),
                    model=model, policy=c['snapshot']['policy'], equity=Decimal(c['capital']['equity']), cash=cash,
                    broker=c['snapshot']['market']['broker'], symbol=c['snapshot']['market']['symbol'],
                    start_time=rows[split['warmup']]['time'])
                periods = {name: mark_period(bars, replay['fills'], start, end, cash)
                           for name, start, end in [('train', split['warmup'], split['train_end']),
                                                   ('validation', split['train_end'], split['validation_end'])]}
                if version == 'legacy' and factor == 1:
                    # Compare numerically because diagnostic Decimal precision is higher.
                    for name, metrics in periods.items():
                        for key, value in metrics.items():
                            expected = data['expected'][name][key]
                            assert value is expected if value is None else abs(Decimal(value) - Decimal(expected)) < Decimal('1e-12')
                results.append({'version': version, 'cost_factor': factor, **periods,
                    **summarize_fills(replay['fills'], rows, split),
                    'rejections': dict(Counter(d['reason'] for d in replay['decisions'] if d['outcome'] == 'REJECTED')),
                    'final_cash': replay['final_cash'], 'position_quantity': replay['position_quantity'],
                    'open_allocations': replay['open_allocations']})
    audit = []
    for binding in c['snapshot']['selection']['bindings']:
        name = binding['pine_variable']
        for bound in ('min', 'max'):
            value = binding['search_domain'][bound]
            alternate = revised_bars(rows, inputs.candidate([name], {name: value}))
            baseline = signal_sets['spot_exit_v1']
            measured = zip(baseline[split['warmup']:], alternate[split['warmup']:], strict=True)
            counts = Counter()
            for before, after in measured:
                counts['buy_changed_bars'] += before.buy != after.buy
                counts['exit_changed_bars'] += before.native_exit != after.native_exit
            audit.append({'input': name, 'bound': bound, 'value': value, **counts})
    counts = {version: {name: {'buy': sum(s.buy for s in signals[start:end]),
                                      'exit': sum(s.native_exit for s in signals[start:end])}
                       for name, start, end in [('train', split['warmup'], split['train_end']),
                                               ('validation', split['train_end'], split['validation_end'])]}
              for version, signals in signal_sets.items()}
    report = {'version': 'spt-spot-exit-v1-development-result', 'recorded_at': datetime.now(timezone.utc).isoformat(),
              'plan_sha256': digest(args.plan), 'runner_sha256': digest(Path(__file__)),
              'evaluator_sha256': plan['evaluator_sha256'], 'holdout_supplied': False,
              'optimization_runs': 0, 'replay_count': len(results), 'baseline_reproduced_within_1e_minus_12': True,
              'signal_counts': counts, 'comparisons': results, 'input_effectiveness': audit,
              'tradingview_parity': 'NOT_CHECKED', 'repaint': 'NOT_CHECKED', 'recommendation_ready': False,
              'limitation': 'Exploratory historical diagnosis of one predeclared exit rule. No independent validation, new search or runtime activation.'}
    with args.output.open('x', encoding='utf-8') as out:
        json.dump(report, out, indent=2)
        out.write('\n')
    print(json.dumps({'signal_counts': counts, 'comparisons': [
        {k: row[k] for k in ['version', 'cost_factor', 'periods', 'rejections', 'open_allocations']}
        for row in results], 'input_effectiveness': audit}))


if __name__ == '__main__':
    main()
