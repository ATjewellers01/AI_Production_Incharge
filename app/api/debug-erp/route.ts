import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// TEMPORARY diagnostic route — added to investigate why the ERP
// dashboard's "Department recovery %" panel and "Recent activity" feed
// show empty/"Unassigned" despite real data existing. Remove this file
// once the investigation is done; it deliberately has no auth check since
// it's meant to be hit directly for a quick one-off look, not left in the
// deployed app long-term.
export async function GET() {
  const [diCount, drCount, diWithActual2, diWithDept, drWithDept, sampleDi, sampleDr] = await Promise.all([
    prisma.departmentIssueEntry.count(),
    prisma.departmentReceiptEntry.count(),
    prisma.departmentIssueEntry.count({ where: { actual2: { not: null } } }),
    prisma.departmentIssueEntry.count({ where: { NOT: { dept: null } } }),
    prisma.departmentReceiptEntry.count({ where: { NOT: { dept: null } } }),
    prisma.departmentIssueEntry.findMany({
      take: 5,
      select: { issueNo: true, dept: true, meltingType: true, actual2: true, karigarName: true },
    }),
    prisma.departmentReceiptEntry.findMany({
      take: 5,
      select: { issueNo: true, dept: true, returnType: true, finishedNet: true },
    }),
  ]);

  return NextResponse.json({
    diCount,
    drCount,
    diWithActual2,
    diWithDept,
    drWithDept,
    sampleDi,
    sampleDr,
  });
}
