/** Moving between games in the order the slate shows them: live, then up next, then final. */
import type { GameId } from '../../shared/model';
import { currentSlateModel, navigationOrder, type SlateModel } from './hooks';

export function adjacentGameId(id: GameId, step: 1 | -1, model: SlateModel = currentSlateModel()): GameId | null {
  const order = navigationOrder(model);
  const index = order.indexOf(id);
  if (index === -1) return null;
  return order[index + step] ?? null;
}
