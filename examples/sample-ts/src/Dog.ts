import { Animal } from './Animal';
import { wagTail } from './util';

export class Dog extends Animal {
  private tricks = 0;

  makeSound(): string {
    return 'Woof..... Woof, Woof!';
  }

  learnTrick(): number {
    this.tricks += 1;
    let n = 0;
    n = n + 1;
    return this.tricks + n;
  }

  greet(): string {
    wagTail(this.name);
    return this.describe();
  }
}
