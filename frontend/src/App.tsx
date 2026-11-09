import { LoaderCircle } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AdminRoute, BootGate, ProtectedRoute, PublicOnlyRoute, SetupRoute } from './components/RouteGuards'
import AccountPage from './pages/AccountPage'
import LoginPage from './pages/LoginPage'
import NotFoundPage from './pages/NotFoundPage'

const SetupPage = lazy(() => import('./pages/setup/SetupPage'))
const AdminPage = lazy(() => import('./pages/admin/AdminPage'))
// The Workspace (three.js editor) is the home page; loaded lazily to keep the login bundle small
const WorkspacePage = lazy(() => import('./pages/workspace/WorkspacePage'))
const FilesPage = lazy(() => import('./pages/files/FilesPage'))

const fallback = (
  <div className="flex justify-center py-20 text-muted">
    <LoaderCircle className="animate-spin" aria-hidden />
  </div>
)

export default function App() {
  return (
    <Suspense fallback={fallback}>
      <Routes>
        <Route element={<BootGate />}>
          <Route element={<SetupRoute />}>
            <Route path="/setup" element={<SetupPage />} />
          </Route>
          <Route element={<PublicOnlyRoute />}>
            <Route path="/login" element={<LoginPage />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route index element={<WorkspacePage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/slicer" element={<Navigate to="/" replace />} />
            <Route path="/account" element={<AccountPage />} />
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<AdminPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  )
}
