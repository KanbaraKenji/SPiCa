// 支持图片: an eye after a model's name, in the 切换模型 menu and in 设置 › 模型.
// Only models known to take pictures get it; text-only and unknown ones get nothing.
import { Icon } from './Icon';
import { t } from '../../../shared/i18n';

export function ImageMark({ size = 14 }: { size?: number }) {
  return (
    <span className="image-mark" role="img" aria-label={t('支持图片')} title={t('支持图片')}>
      <Icon name="eye" size={size} />
    </span>
  );
}
