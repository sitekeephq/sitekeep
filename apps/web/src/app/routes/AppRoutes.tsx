import { lazy, Suspense } from "react";
import type { UserDto } from "@sitekeep/shared";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "../../features/auth/pages/Login";
import { AccountPage } from "../../features/auth/pages/Account";
import { IssuesPage } from "../../features/coordination/pages/Issues";
import { CoordinationPage } from "../../features/coordination/pages/Coordination";
import { DocsPage } from "../../features/documents/DocsPage";
import { DeletedPage } from "../../features/documents/pages/Deleted";
import { PdfViewerPage } from "../../features/documents/pages/PdfViewer";
import { DocComparePage } from "../../features/documents/pages/DocCompare";
import { AfterLoginPage, OAuthConsentPage } from "../../features/integrations/pages/OAuthConsent";
import { OpenCdeSelectPage, OpenCdeUploadPage } from "../../features/integrations/pages/OpenCdeDocuments";
import { LocationsPage } from "../../features/project-settings/pages/Locations";
import { ProjectSettingsPage } from "../../features/project-settings/pages/ProjectSettings";
import { ProjectsPage } from "../../features/projects/pages/Projects";
import { ReportsPage } from "../../features/reports/pages/Reports";
import { ReportViewPage } from "../../features/reports/pages/ReportView";
import { SpecAnalysisPage } from "../../features/reports/pages/SpecAnalysis";
import { ReviewsPage } from "../../features/reviews/pages/Reviews";
import { webModules } from "../modules";
import { ProjectTodayPage } from "../../features/works/pages/ProjectToday";
import { TodayPage } from "../../features/works/pages/Today";
import { WorksPage } from "../../features/works/pages/Works";
import { WorksHub } from "../../features/works/pages/WorksHub";
import { AdminPage } from "../../features/admin/pages/Admin";
import { ProjectStatusPage } from "../../features/admin/pages/AdminStatus";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { ProjectShell } from "../layout/ProjectShell";
import { Shell } from "../layout/Shell";
import { LegacyProjectRedirect } from "./LegacyProjectRedirect";

const OpenPage = lazy(() => import("../../viewers/OpenPage"));
// The 3D viewer (That Open + three.js, most of the bundle) loads only when the model page opens.
const ViewerPage = lazy(() => import("../../features/coordination/pages/Viewer").then((m) => ({ default: m.ViewerPage })));

export function AppRoutes({ user }: { user: UserDto | null }) {
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
        <Route path="/opencde/upload" element={<OpenCdeUploadPage />} />
        <Route path="/opencde/select" element={<OpenCdeSelectPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<AfterLoginPage />} />
      <Route path="/oauth/consent" element={<OAuthConsentPage />} />
      <Route path="/opencde/upload" element={<OpenCdeUploadPage />} />
      <Route path="/opencde/select" element={<OpenCdeSelectPage />} />
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home" element={<ProjectsPage />} />
        <Route path="administration" element={user.isAdmin ? <AdminPage /> : <Navigate to="/home" replace />} />
        <Route path="admin" element={<Navigate to="/administration" replace />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="tasks" element={<TodayPage />} />
        <Route path="today" element={<Navigate to="/tasks" replace />} />
        <Route path="projects/:pid" element={<ProjectShell />}>
          <Route index element={<Navigate to="files" replace />} />
          <Route path="today" element={<ProjectTodayPage />} />
          <Route path="files" element={<DocsPage />} />
          <Route path="files/:fid" element={<DocsPage />} />
          <Route path="deleted" element={<DeletedPage />} />
          <Route path="view/:versionId" element={<PdfViewerPage />} />
          <Route path="compare" element={<DocComparePage />} />
          <Route
            path="open/:versionId"
            element={
              <Suspense fallback={<LoadingIndicator className="page" />}>
                <OpenPage />
              </Suspense>
            }
          />
          <Route element={<WorksHub />}>
            <Route path="works" element={<WorksPage />} />
            <Route path="works/:wid" element={<WorksPage />} />
          </Route>
          <Route path="issues" element={<IssuesPage />} />
          <Route path="issues/:iid" element={<IssuesPage />} />
          <Route path="reviews" element={<ReviewsPage />} />
          <Route path="reviews/:rid" element={<ReviewsPage />} />
          <Route path="locations" element={<LocationsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/:rid" element={<ReportViewPage />} />
          <Route
            path="viewer"
            element={
              <Suspense fallback={<LoadingIndicator className="page" />}>
                <ViewerPage />
              </Suspense>
            }
          />
          <Route path="coordination" element={<Navigate to="sets" replace />} />
          <Route path="coordination/:section" element={<CoordinationPage />} />
          <Route path="coordination/:section/:id" element={<CoordinationPage />} />
          {webModules.flatMap((m) => (m.projectRoutes ?? []).map((r) => <Route key={`${m.id}:${r.path}`} path={r.path} element={r.element} />))}
          <Route path="settings" element={<ProjectSettingsPage />} />
          <Route path="sistem-durumu" element={<ProjectStatusPage />} />
          <Route path="spec" element={<SpecAnalysisPage />} />
          <Route path="spec/:rid" element={<SpecAnalysisPage />} />
        </Route>
        <Route path="p/:pid/*" element={<LegacyProjectRedirect />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Route>
    </Routes>
  );
}
