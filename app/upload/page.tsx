import { redirect } from 'next/navigation'

/**
 * Upload is done via the organization tree only.
 * This route redirects to the upload-tree page.
 */
export default function UploadPage() {
  redirect('/upload-tree')
}
