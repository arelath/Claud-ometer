'use client';

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useProjects, useCacheStatus } from '@/lib/hooks';
import { useCostMode } from '@/lib/cost-mode-context';
import type { ProjectInfo } from '@/lib/claude-data/types';
import type { TimeRangeParams } from '@/lib/time-range';

export default function ProjectCostChart({ range, initialProjects }: { range: TimeRangeParams; initialProjects?: ProjectInfo[] }) {
  const { data: projects, mutate, error } = useProjects(initialProjects, range);
  useCacheStatus(mutate);
  const { pickCost } = useCostMode();
  const data = (projects || [])
    .map(project => ({ name: project.name, cost: pickCost(project.estimatedCosts, project.estimatedCost) }))
    .filter(project => project.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(project => ({ ...project, cost: Number(project.cost.toFixed(2)) }));
  return (
    <Card className="h-full border-border/50 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Estimated Cost by Project</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[300px]">
          {projects ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                layout="vertical"
                margin={{ top: 5, right: 20, left: 5, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${v}`}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  axisLine={false}
                  tickLine={false}
                  width={100}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [`$${Number(value).toFixed(2)}`, 'Est. Cost']}
                />
                <Bar isAnimationActive={false} dataKey="cost" fill="var(--primary)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {error ? 'Could not load project costs.' : 'Loading project costs...'}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
