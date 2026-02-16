'use client'

import { useState, ReactNode } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, Users, Building2, FileUp, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TreeNode {
  id: string
  label: string
  icon?: ReactNode
  children?: TreeNode[]
  data?: any
  onClick?: () => void
  badge?: string | number
  isActive?: boolean
  /** Used by UploadTree for carrier-level nodes (agency_carriers.id). */
  agencyCarrierId?: string
}

interface TreeProps {
  nodes: TreeNode[]
  defaultExpanded?: string[]
  onNodeClick?: (node: TreeNode) => void
  className?: string
  showRoot?: boolean
  rootLabel?: string
}

export function Tree({ nodes, defaultExpanded = [], onNodeClick, className, showRoot = false, rootLabel = 'Root' }: TreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(defaultExpanded))

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const renderNode = (node: TreeNode, level: number = 0, parentId?: string): ReactNode => {
    const hasChildren = node.children && node.children.length > 0
    const isExpanded = expanded.has(node.id)
    const indent = level * 24
    const isTopLevel = level === 0

    return (
      <div key={node.id} className="select-none relative">
        {/* Vertical connector line for nested children */}
        {level > 0 && (
          <div
            className="absolute left-0 top-0 bottom-0 w-px bg-slate-700/50"
            style={{ left: `${indent - 8}px` }}
          />
        )}
        
        <div
          className={cn(
            'group flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 relative',
            'hover:bg-slate-800/70 hover:shadow-sm',
            node.isActive && 'bg-slate-800/80 border-l-2 border-orange-500 shadow-sm',
            isTopLevel && 'font-medium bg-slate-800/30 hover:bg-slate-800/50',
            !hasChildren && level > 0 && 'ml-1'
          )}
          style={{ paddingLeft: `${12 + indent}px` }}
          onClick={() => {
            if (hasChildren) {
              toggle(node.id)
            }
            if (node.onClick) {
              node.onClick()
            }
            if (onNodeClick) {
              onNodeClick(node)
            }
          }}
        >
          {/* Expand/Collapse Icon */}
          <div className="w-5 h-5 flex items-center justify-center shrink-0 -ml-1">
            {hasChildren ? (
              <div 
                className="transition-transform duration-200 rounded hover:bg-slate-700/50 p-0.5" 
                style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-200" />
              </div>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-slate-500 group-hover:bg-slate-400 transition-colors" />
            )}
          </div>

          {/* Node Icon */}
          <div className={cn(
            'w-5 h-5 flex items-center justify-center shrink-0 transition-colors',
            isTopLevel ? 'text-slate-200' : 'text-slate-400 group-hover:text-slate-200'
          )}>
            {node.icon || (
              hasChildren ? (
                isExpanded ? (
                  <FolderOpen className="w-4 h-4" />
                ) : (
                  <Folder className="w-4 h-4" />
                )
              ) : (
                <FileText className="w-4 h-4" />
              )
            )}
          </div>

          {/* Label */}
          <span className={cn(
            'flex-1 text-sm truncate transition-colors',
            isTopLevel ? 'text-slate-100 font-semibold' : 'text-slate-300',
            node.isActive && 'text-orange-400 font-medium'
          )}>
            {node.label}
          </span>

          {/* Badge */}
          {node.badge !== undefined && (
            <span className={cn(
              'px-2 py-0.5 text-xs font-medium rounded-full transition-colors',
              isTopLevel 
                ? 'bg-orange-600/20 text-orange-300 border border-orange-600/30' 
                : 'bg-slate-800 text-slate-300 group-hover:bg-slate-700'
            )}>
              {node.badge}
            </span>
          )}
        </div>

        {/* Children */}
        {hasChildren && (
          <div
            className={cn(
              'overflow-hidden transition-all duration-300 ease-in-out relative',
              isExpanded ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0'
            )}
          >
            {/* Vertical line connecting parent to children */}
            {isExpanded && (
              <div
                className="absolute left-0 top-0 bottom-0 w-px bg-slate-700/50"
                style={{ left: `${indent + 4}px` }}
              />
            )}
            <div className="relative">
              {node.children!.map((child, idx) => (
                <div key={child.id} className="relative">
                  {/* Horizontal connector line */}
                  {idx < node.children!.length - 1 && (
                    <div
                      className="absolute left-0 top-6 bottom-0 w-px bg-slate-700/50"
                      style={{ left: `${indent + 4}px` }}
                    />
                  )}
                  {renderNode(child, level + 1, node.id)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (showRoot) {
    const rootNode: TreeNode = {
      id: 'root',
      label: rootLabel,
      children: nodes,
      icon: <Building2 className="w-4 h-4" />,
    }
    return (
      <div className={cn('bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg', className)}>
        <div className="p-3">
          {renderNode(rootNode, -1)}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg', className)}>
      <div className="p-3 space-y-0.5">
        {nodes.map((node) => renderNode(node, 0))}
      </div>
    </div>
  )
}

interface TreeViewProps {
  className?: string
}

export function TreeView({ className }: TreeViewProps) {
  // This is a placeholder - you'll populate this with real data from Supabase
  const [treeData, setTreeData] = useState<TreeNode[]>([])

  return (
    <div className={cn('space-y-4', className)}>
      <Tree nodes={treeData} />
    </div>
  )
}
