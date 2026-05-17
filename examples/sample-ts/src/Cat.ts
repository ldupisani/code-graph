import { Animal } from './Animal';

export class Cat extends Animal {
  makeSound(): string {
    return 'Meow.';
  }
}
