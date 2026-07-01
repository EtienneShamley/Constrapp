import Card from '../../components/Card'
import Badge from '../../components/Badge'

export default function ProjectPlaceholder({ icon, title, description, badge = 'Coming Soon' }) {
  return (
    <Card className="text-center py-16">
      <div className="text-5xl mb-4 leading-none">{icon}</div>
      <h3 className="text-brand-text font-bold text-lg mb-2 m-0">{title}</h3>
      <p className="text-brand-muted text-sm mb-4 max-w-md mx-auto">{description}</p>
      <Badge label={badge} variant="soon" />
    </Card>
  )
}
