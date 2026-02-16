import { redirect } from 'next/navigation'

/**
 * Old organization tree route. Upload tree is the only tree view now.
 */
export default function TreePage() {
  redirect('/upload-tree')
}
