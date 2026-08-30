import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, User, Lock, LogOut, AlertCircle, CheckCircle, Edit2 } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { changePassword } from '@/lib/auth-client'

export function AccountSettings() {
  const { user, logout } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [editingProfile, setEditingProfile] = useState(false)

  const changePasswordMutation = useMutation({
    mutationFn: async ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) => {
      await changePassword(currentPassword, newPassword)
    },
    onSuccess: () => {
      setSuccess('Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setShowChangePassword(false)
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to change password')
    },
  })

  const handleChangePassword = () => {
    setError(null)
    setSuccess(null)
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }
    changePasswordMutation.mutate({ currentPassword, newPassword })
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-500 text-green-700 dark:text-green-400">
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <Card className="border-0 shadow-none">
          <CardHeader className="pb-3 sm:pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 sm:h-5 sm:w-5" />
                <CardTitle className="text-base sm:text-lg">Profile</CardTitle>
              </div>
              {!editingProfile && (
                <Button variant="ghost" size="sm" onClick={() => setEditingProfile(true)} className="h-8">
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {editingProfile ? (
              <div className="space-y-3 sm:space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm">Name</Label>
                  <Input value={user.name as string} disabled className="h-9 sm:h-10 md:text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs sm:text-sm">Email</Label>
                  <Input value={user.email as string} disabled className="h-9 sm:h-10 md:text-sm" />
                </div>
                <Button variant="outline" onClick={() => setEditingProfile(false)} className="h-9 sm:h-10">
                  Done
                </Button>
              </div>
            ) : (
              <div className="space-y-2 sm:space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                  <span className="text-xs sm:text-sm text-muted-foreground sm:w-20">Name</span>
                  <span className="text-sm font-medium truncate">{user.name as string}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                  <span className="text-xs sm:text-sm text-muted-foreground sm:w-20">Email</span>
                  <span className="text-sm truncate">{user.email as string}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-none">
          <CardHeader className="pb-2 sm:pb-4">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Lock className="h-4 w-4 sm:h-5 sm:w-5" />
              Change Password
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">Update your account password</CardDescription>
          </CardHeader>
          <CardContent>
            {!showChangePassword ? (
              <Button
                variant="outline"
                onClick={() => setShowChangePassword(true)}
                className="h-9 sm:h-10"
              >
                <Lock className="mr-2 h-4 w-4" />
                Change Password
              </Button>
            ) : (
              <div className="space-y-3 sm:space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="current-password" className="text-xs sm:text-sm">Current Password</Label>
                  <Input
                    id="current-password"
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="h-9 sm:h-10 md:text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-password" className="text-xs sm:text-sm">New Password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="h-9 sm:h-10 md:text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleChangePassword}
                    disabled={changePasswordMutation.isPending || !currentPassword || !newPassword}
                    className="h-9 sm:h-10"
                  >
                    {changePasswordMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Lock className="mr-2 h-4 w-4" />
                    )}
                    Change Password
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setShowChangePassword(false)}
                    className="h-9 sm:h-10"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 shadow-none">
        <CardHeader className="pb-2 sm:pb-4">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-destructive">
            <LogOut className="h-4 w-4 sm:h-5 sm:w-5" />
            Sign Out
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">Sign out of your account</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={logout} className="h-9 sm:h-10">
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
